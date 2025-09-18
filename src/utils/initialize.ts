import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { createMint, createAccount } from '@solana/spl-token';
import { getProgram, connection, GLOBAL_PDA } from './program';

// Initialize the program with global state and action types
export async function initializeProgram(walletContext: any) {
  if (!walletContext.connected || !walletContext.publicKey) {
    throw new Error('Wallet not connected');
  }

  const program = getProgram(walletContext);
  const adminPublicKey = walletContext.publicKey;
  
  // Find the global PDA
  const [globalPDA] = findGlobalPDA(adminPublicKey);
  
  try {
    // Check if already initialized
    const existingGlobal = await (program.account as any).globalState.fetch(globalPDA);
    console.log('Program already initialized:', existingGlobal);
    return existingGlobal;
  } catch {
    // Not initialized yet, proceed with initialization
  }

  console.log('Initializing program...');

  // Create points mint
  const pointsMint = await createMint(
    connection,
    walletContext.wallet.adapter as any,
    globalPDA, // Global PDA will be the mint authority
    null, // No freeze authority
    6 // 6 decimals
  );

  console.log('Created points mint:', pointsMint.toString());

  // Create a vault token account (for potential future use)
  const vaultAccount = await createAccount(
    connection,
    walletContext.wallet.adapter as any,
    pointsMint,
    globalPDA
  );

  console.log('Created vault account:', vaultAccount.toString());

  // Initialize global state
  const verifiers = [adminPublicKey]; // Admin is also a verifier for MVP
  const params = {
    paused: false,
    dailyCap: new anchor.BN(10000), // 10,000 points per day cap
    perTxCapDefault: new anchor.BN(100), // 100 points per transaction default
    cooldownSecsDefault: 3600, // 1 hour cooldown default
  };

  try {
    const tx = await program.methods
      .initialize(verifiers, params)
      .accounts({
        admin: adminPublicKey,
        global: globalPDA,
        pointsMint: pointsMint,
        vault: vaultAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log('Initialization transaction:', tx);

    // Register the tree planting action type
    await registerTreePlantingAction(program, adminPublicKey, globalPDA);

    console.log('Program initialized successfully!');
    
    return await (program.account as any).globalState.fetch(globalPDA);
  } catch (error) {
    console.error('Error initializing program:', error);
    throw error;
  }
}

async function registerTreePlantingAction(program: any, admin: PublicKey, globalPDA: PublicKey) {
  const slug = stringToSlug('tree_planting');
  const [actionTypePDA] = findActionTypePDA(globalPDA, slug);

  try {
    // Check if action type already exists
    await (program.account as any).actionType.fetch(actionTypePDA);
    console.log('Tree planting action type already exists');
    return;
  } catch {
    // Doesn't exist, create it
  }

  try {
    const tx = await program.methods
      .registerActionType(
        slug,
        'Tree Planting',
        new anchor.BN(100), // 100 points per tree
        0, // unit: 0 = tree
        'https://example.com/tree-badge', // badge URI
        3600, // 1 hour cooldown
        new anchor.BN(10) // max 10 trees per transaction
      )
      .accounts({
        admin: admin,
        global: globalPDA,
        actionType: actionTypePDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log('Tree planting action type registered:', tx);
  } catch (error) {
    console.error('Error registering tree planting action:', error);
    throw error;
  }
}

// Check if program is initialized
export async function checkInitialization(walletContext: any) {
  if (!walletContext.connected || !walletContext.publicKey) {
    return false;
  }

  try {
    const program = getProgram(walletContext);
    const [globalPDA] = findGlobalPDA(walletContext.publicKey);
    
    await (program.account as any).globalState.fetch(globalPDA);
    return true;
  } catch {
    return false;
  }
}