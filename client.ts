import anchor from "@coral-xyz/anchor";
import web3 from "@solana/web3.js";
import splToken from "@solana/spl-token";

const {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = web3;

const {
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
} = splToken;

// Configuration - The program ID is handled by Solana Playground
const PROGRAM_ID = new PublicKey("8A6sABcgD2sMgQNWADUH2EakHnTy171tkKD11jPXNHkK");

// Helper functions (these are fine as is)
function findGlobalPDA(admin) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global"), admin.toBuffer()],
    PROGRAM_ID
  );
}

function findActionTypePDA(global, slug) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("action_type"), global.toBuffer(), Buffer.from(slug)],
    PROGRAM_ID
  );
}

function stringToSlug(str) {
  const slug = new Array(16).fill(0);
  for (let i = 0; i < Math.min(str.length, 16); i++) {
    slug[i] = str.charCodeAt(i);
  }
  return slug;
}

// Register action types for the initialized program
async function registerActionTypes(
  program,
  admin,
  globalPDA
) {
  console.log("🌳 Registering action types...");

  const actionTypes = [
    {
      slug: "tree_planting",
      name: "Tree Planting",
      pointsPerUnit: 100,
      unit: 0,
      badgeUri: "https://example.com/tree-badge",
      cooldownSecs: 3600,
      perTxCap: 10,
    },
    {
      slug: "waste_collection",
      name: "Waste Collection",
      pointsPerUnit: 50,
      unit: 1,
      badgeUri: "https://example.com/waste-badge",
      cooldownSecs: 1800,
      perTxCap: 20,
    },
  ];

  for (const actionType of actionTypes) {
    const slug = stringToSlug(actionType.slug);
    const [actionTypePDA] = findActionTypePDA(globalPDA, slug);

    try {
      await program.account.actionType.fetch(actionTypePDA);
      console.log(`✅ Action type '${actionType.name}' already exists`);
      continue;
    } catch {
      // Doesn't exist, create it
    }

    try {
      const tx = await program.methods
        .registerActionType(
          slug,
          actionType.name,
          new anchor.BN(actionType.pointsPerUnit),
          actionType.unit,
          actionType.badgeUri,
          actionType.cooldownSecs,
          new anchor.BN(actionType.perTxCap)
        )
        .accounts({
          admin: admin,
          global: globalPDA,
          actionType: actionTypePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`✅ Registered '${actionType.name}' action type: ${tx}`);
    } catch (error) {
      console.error(`❌ Error registering '${actionType.name}':`, error);
    }
  }
}

// Main initialization function
async function initializeCarbonProgram() {
  console.log("🚀 Initializing Carbon Credits Program...");
  console.log(`Program ID: ${pg.PROGRAM_ID.toString()}`);

  const program = pg.program;
  const provider = program.provider;
  const adminKeypair = provider.wallet.publicKey;
  
  const wallet = provider.wallet; 
  
  console.log(`Admin wallet: ${adminKeypair.toString()}`);

  const balance = await provider.connection.getBalance(adminKeypair);
  console.log(`💰 Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.warn("⚠️ Low SOL balance. You may need more SOL for transactions.");
  }

  const [globalPDA] = findGlobalPDA(adminKeypair);
  console.log(`🔗 Global PDA: ${globalPDA.toString()}`);

  try {
    await program.account.globalState.fetch(globalPDA);
    console.log("✅ Program already initialized!");
    await registerActionTypes(program, adminKeypair, globalPDA);
    return;
  } catch (error) {
    console.log("📝 Program not initialized yet, proceeding...");
  }

  console.log("🪙 Creating points mint...");
  const pointsMint = anchor.web3.Keypair.generate();
  
  const lamportsForMint = await getMinimumBalanceForRentExemptMint(provider.connection);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: pointsMint.publicKey,
      space: MINT_SIZE,
      lamports: lamportsForMint,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      pointsMint.publicKey,
      6,
      globalPDA,
      null,
      TOKEN_PROGRAM_ID
    )
  );

  const mintTxId = await provider.sendAndConfirm(createMintTx, [pointsMint]); 
  console.log(`✅ Points mint created: ${pointsMint.publicKey.toString()} (Tx: ${mintTxId})`);

  console.log("🏦 Creating vault account...");
  const vaultAccount = await getAssociatedTokenAddress(
    pointsMint.publicKey,
    globalPDA,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const createATAIx = createAssociatedTokenAccountInstruction(
    wallet.publicKey,
    vaultAccount,
    globalPDA,
    pointsMint.publicKey,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const createATATx = new Transaction().add(createATAIx);
  const ataTxId = await provider.sendAndConfirm(createATATx, []);

  console.log(`✅ Vault account created: ${vaultAccount.toString()} (Tx: ${ataTxId})`);

  console.log("🔧 Initializing global state...");
  const verifiers = [adminKeypair];
  const params = {
    paused: false,
    dailyCap: new anchor.BN(10000),
    perTxCapDefault: new anchor.BN(100),
    cooldownSecsDefault: 3600,
  };

  try {
    const tx = await program.methods
      .initialize(verifiers, params)
      .accounts({
        admin: adminKeypair,
        global: globalPDA,
        pointsMint: pointsMint.publicKey,
        vault: vaultAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log(`✅ Global state initialized! Transaction: ${tx}`);
    await provider.connection.confirmTransaction(tx, "confirmed");
  } catch (error) {
    console.error("❌ Error initializing global state:", error);
    throw error;
  }

  await registerActionTypes(program, adminKeypair, globalPDA);

  console.log("🎉 Program initialization complete!");
  return {
    admin: adminKeypair,
    globalPDA,
    pointsMint: pointsMint.publicKey,
    vaultAccount,
    programId: pg.PROGRAM_ID,
  };
}

// Run the initialization
initializeCarbonProgram()
  .then((result) => {
    console.log("\n✨ Initialization completed successfully!");
    console.log("Result:", result);
  })
  .catch((error) => {
    console.error("\n💥 Initialization failed:", error);
  });
