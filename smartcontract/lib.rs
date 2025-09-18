use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo, Burn};
// use anchor_spl::token::spl_token::state::COption;

declare_id!("8A6sABcgD2sMgQNWADUH2EakHnTy171tkKD11jPXNHkK");

#[program]
pub mod carbon {
    use super::*;

    // 1) one-time setup
    pub fn initialize(
        ctx: Context<Initialize>,
        verifiers: Vec<Pubkey>,
        params: Params,
    ) -> Result<()> {
        let g = &mut ctx.accounts.global;
        g.admin = ctx.accounts.admin.key();
        g.points_mint = ctx.accounts.points_mint.key();
        g.vault = ctx.accounts.vault.key();
        g.verifiers = verifiers;
        g.params = params;
        g.bump_global = ctx.bumps.global;

        emit!(Initialized { admin: g.admin, points_mint: g.points_mint });
        Ok(())
    }

    // 2) define/adjust action types
    pub fn register_action_type(
        ctx: Context<RegisterActionType>,
        slug: [u8;16],
        name: String,
        points_per_unit: u64,
        unit: u8,
        badge_uri: String,
        cooldown_secs: u32,
        per_tx_cap: u64,
    ) -> Result<()> {
        require_admin(&ctx.accounts.global, &ctx.accounts.admin)?;
        let at = &mut ctx.accounts.action_type;
        at.global = ctx.accounts.global.key();
        at.slug = slug;
        at.name = name;
        at.points_per_unit = points_per_unit;
        at.unit = unit;
        at.badge_metadata_uri = badge_uri;
        at.cooldown_secs = cooldown_secs;
        at.per_tx_cap = per_tx_cap;
        Ok(())
    }

    // 3) minimal member record
    pub fn join(ctx: Context<Join>, profile_uri: Option<String>) -> Result<()> {
        let m = &mut ctx.accounts.member;
        m.owner = ctx.accounts.user.key();
        m.points = 0;
        m.joined_at = Clock::get()?.unix_timestamp;
        m.profile_uri = profile_uri;
        Ok(())
    }

    // 4) submit proof (hashes) for an action
    // NOTE: pass client_nonce so the Submission PDA seed is deterministic.
    pub fn submit_action(
        ctx: Context<SubmitAction>,
        slug: [u8;16],
        amount: u64,
        client_nonce: u64,
        evidence_hash: [u8;32],
        location_hash: [u8;32],
    ) -> Result<()> {
        let _ = slug;
        let g = &ctx.accounts.global;
        require!(!g.params.paused, ErrorCode::Paused);

        let at = &ctx.accounts.action_type;
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(amount <= at.per_tx_cap, ErrorCode::InvalidAmount);

        let s = &mut ctx.accounts.submission;
        s.member = ctx.accounts.member.key();
        s.member_owner = ctx.accounts.user.key();
        s.action_type = ctx.accounts.action_type.key();
        s.amount = amount;
        s.evidence_hash = evidence_hash;
        s.location_hash = location_hash;
        s.status = Status::Pending as u8;
        s.created_at = Clock::get()?.unix_timestamp;
        s.client_nonce = client_nonce;

        emit!(ActionSubmitted {
            member: s.member_owner,
            action_type: at.slug,
            amount
        });
        Ok(())
    }

    // 5) verifier approves/rejects; on approve → mint points
    pub fn verify_action(ctx: Context<VerifyAction>, approve: bool) -> Result<()> {
        let g = &ctx.accounts.global;
        require!(g.verifiers.contains(&ctx.accounts.verifier.key()), ErrorCode::UnauthorizedVerifier);

        let s = &mut ctx.accounts.submission;
        require!(s.status == Status::Pending as u8, ErrorCode::NotPending);

        if !approve {
            s.status = Status::Rejected as u8;
            emit!(ActionRejected { member: s.member_owner, submission: s.key() });
            return Ok(());
        }

        // approved → award points
        let at = &ctx.accounts.action_type;
        let points = at.points_per_unit.checked_mul(s.amount).ok_or(ErrorCode::MathOverflow)?;

        // Signer seeds for Global PDA
        let seeds: &[&[u8]] = &[b"global", g.admin.as_ref(), &[g.bump_global]];
        let signer = &[seeds];

        // mint points to member
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.points_mint.to_account_info(),
                    to: ctx.accounts.member_points_ata.to_account_info(),
                    authority: ctx.accounts.global.to_account_info(),
                },
                signer
            ),
            points,
        )?;

        // update member tally
        let m = &mut ctx.accounts.member;
        m.points = m.points.checked_add(points).ok_or(ErrorCode::MathOverflow)?;

        s.status = Status::Approved as u8;
        emit!(ActionApproved {
            member: s.member_owner,
            action_type: at.slug,
            points,
            verifier: ctx.accounts.verifier.key()
        });
        Ok(())
    }

    // 6) redeem points with a partner (simple burn + event)
    pub fn redeem_with_partner(ctx: Context<Redeem>, points: u64, partner_slug: [u8;16]) -> Result<()> {
        let g = &ctx.accounts.global;
        require!(!g.params.paused, ErrorCode::Paused);
        require!(points > 0, ErrorCode::InvalidAmount);

        // burn member points
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.points_mint.to_account_info(),
                    from: ctx.accounts.member_points_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                }
            ),
            points,
        )?;

        emit!(Redeemed { member: ctx.accounts.user.key(), partner_slug, points });
        Ok(())
    }

    // 7) admin controls
    pub fn set_params(ctx: Context<SetParams>, params: Params) -> Result<()> {
        require_admin(&ctx.accounts.global, &ctx.accounts.admin)?;
        ctx.accounts.global.params = params;
        emit!(ParamsUpdated{ admin: ctx.accounts.admin.key() });
        Ok(())
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        require_admin(&ctx.accounts.global, &ctx.accounts.admin)?;
        ctx.accounts.global.params.paused = true;
        emit!(Paused{ by: ctx.accounts.admin.key() });
        Ok(())
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        require_admin(&ctx.accounts.global, &ctx.accounts.admin)?;
        ctx.accounts.global.params.paused = false;
        emit!(Unpaused{ by: ctx.accounts.admin.key() });
        Ok(())
    }
}

// ---------- STATE ----------

#[account]
pub struct GlobalState {
    pub admin: Pubkey,              // signer who can change params/types
    pub points_mint: Pubkey,        // SPL mint for "GreenPoints"
    pub vault: Pubkey,              // (optional) treasury/vault account
    pub verifiers: Vec<Pubkey>,     // allowed approvers
    pub params: Params,
    pub bump_global: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct Params {
    pub paused: bool,
    pub daily_cap: u64,             // not enforced in MVP
    pub per_tx_cap_default: u64,    // not enforced in MVP
    pub cooldown_secs_default: u32, // not enforced in MVP
}

#[account]
pub struct ActionType {
    pub global: Pubkey,
    pub slug: [u8;16],             // PDA key part
    pub name: String,
    pub points_per_unit: u64,
    pub unit: u8,                  // 0=tree,1=kg,2=km...
    pub badge_metadata_uri: String,
    pub cooldown_secs: u32,
    pub per_tx_cap: u64,
}

#[account]
pub struct Member {
    pub owner: Pubkey,
    pub points: u64,
    pub joined_at: i64,
    pub profile_uri: Option<String>,
}

#[account]
pub struct Submission {
    pub member: Pubkey,
    pub member_owner: Pubkey,
    pub action_type: Pubkey,
    pub amount: u64,
    pub evidence_hash: [u8;32],
    pub location_hash: [u8;32],
    pub status: u8,        // 0=Pending,1=Approved,2=Rejected
    pub created_at: i64,
    pub client_nonce: u64, // used in PDA seeds
}

#[repr(u8)]
pub enum Status { Pending=0, Approved=1, Rejected=2 }

// ---------- ACCOUNTS ----------

#[derive(Accounts)]
#[instruction(verifiers: Vec<Pubkey>, params: Params)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Global PDA (program signer)
    #[account(
        init,
        payer = admin,
        seeds = [b"global", admin.key().as_ref()],
        bump,
        space = 8 + 32 + 32 + 32 + 4 + (32*8) + 64 + 1 + 256
    )]
    pub global: Account<'info, GlobalState>,

    #[account(mut)]
    pub points_mint: Account<'info, Mint>,

    /// vault is optional (e.g., partner treasury); can be any token account
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(
    slug: [u8;16],
    name: String,
    points_per_unit: u64,
    unit: u8,
    badge_uri: String,
    cooldown_secs: u32,
    per_tx_cap: u64
)]
pub struct RegisterActionType<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"global", global.admin.as_ref()],
        bump = global.bump_global,
    )]
    pub global: Account<'info, GlobalState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"action_type", global.key().as_ref(), slug.as_ref()],
        bump,
        space = 8   // disc
            + 32   // global
            + 16   // slug
            + 64   // name (approx)
            + 8    // points_per_unit
            + 1    // unit
            + 128  // badge_uri (approx)
            + 4    // cooldown_secs
            + 8    // per_tx_cap
    )]
    pub action_type: Account<'info, ActionType>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        seeds = [b"member", user.key().as_ref()],
        bump,
        space = 8 + 32 + 8 + 8 + 96
    )]
    pub member: Account<'info, Member>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    slug: [u8;16],
    amount: u64,
    client_nonce: u64,
    evidence_hash: [u8;32],
    location_hash: [u8;32]
)]
pub struct SubmitAction<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub global: Account<'info, GlobalState>,

    #[account(
        seeds = [b"member", user.key().as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,

    #[account(
        seeds = [b"action_type", global.key().as_ref(), slug.as_ref()],
        bump
    )]
    pub action_type: Account<'info, ActionType>,

    #[account(
        init,
        payer = user,
        seeds = [b"submission", user.key().as_ref(), &client_nonce.to_le_bytes()],
        bump,
        space = 8
            + 32  // member
            + 32  // member_owner
            + 32  // action_type
            + 8   // amount
            + 32  // evidence_hash
            + 32  // location_hash
            + 1   // status
            + 8   // created_at
            + 8   // client_nonce
    )]
    pub submission: Account<'info, Submission>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyAction<'info> {
    pub verifier: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global", global.admin.as_ref()],
        bump = global.bump_global,
    )]
    pub global: Account<'info, GlobalState>,

    #[account()]
    pub action_type: Account<'info, ActionType>,

    #[account(
        mut,
        seeds = [b"member", submission.member_owner.as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,

    #[account(mut)]
    pub submission: Account<'info, Submission>,

    #[account(mut)]
    pub points_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = member_points_ata.mint == points_mint.key(),
        constraint = member_points_ata.owner == submission.member_owner
    )]
    pub member_points_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub global: Account<'info, GlobalState>,

    #[account(mut)]
    pub points_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = member_points_ata.mint == points_mint.key(),
        constraint = member_points_ata.owner == user.key()
    )]
    pub member_points_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"global", global.admin.as_ref()],
        bump = global.bump_global,
    )]
    pub global: Account<'info, GlobalState>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"global", global.admin.as_ref()],
        bump = global.bump_global,
    )]
    pub global: Account<'info, GlobalState>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"global", global.admin.as_ref()],
        bump = global.bump_global,
    )]
    pub global: Account<'info, GlobalState>,
}

// ---------- HELPERS ----------
fn require_admin(global: &GlobalState, admin: &Signer) -> Result<()> {
    require_keys_eq!(global.admin, admin.key(), ErrorCode::UnauthorizedAdmin);
    Ok(())
}

// ---------- EVENTS ----------
#[event]
pub struct Initialized { pub admin: Pubkey, pub points_mint: Pubkey }
#[event]
pub struct ActionSubmitted { pub member: Pubkey, pub action_type: [u8;16], pub amount: u64 }
#[event]
pub struct ActionApproved { pub member: Pubkey, pub action_type: [u8;16], pub points: u64, pub verifier: Pubkey }
#[event]
pub struct ActionRejected { pub member: Pubkey, pub submission: Pubkey }
#[event]
pub struct Redeemed { pub member: Pubkey, pub partner_slug: [u8;16], pub points: u64 }
#[event]
pub struct ParamsUpdated { pub admin: Pubkey }
#[event]
pub struct Paused { pub by: Pubkey }
#[event]
pub struct Unpaused { pub by: Pubkey }

// ---------- ERRORS ----------
#[error_code]
pub enum ErrorCode {
    #[msg("Program is paused")] Paused,
    #[msg("Only admin may perform this action")] UnauthorizedAdmin,
    #[msg("Verifier not authorized")] UnauthorizedVerifier,
    #[msg("Invalid amount")] InvalidAmount,
    #[msg("Submission is not pending")] NotPending,
    #[msg("Math overflow")] MathOverflow,
    #[msg("Points mint must have Global PDA as mint authority")] BadMintAuthority,
}
