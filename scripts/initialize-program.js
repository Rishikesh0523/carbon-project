const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram, clusterApiUrl } = require('@solana/web3.js');
const { createMint, createAccount, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// Configuration
const PROGRAM_ID = new PublicKey('8A6sABcgD2sMgQNWADUH2EakHnTy171tkKD11jPXNHkK');
const NETWORK = 'devnet'; // Change to 'mainnet-beta' for mainnet
const connection = new Connection(clusterApiUrl(NETWORK), 'confirmed');

// Load your IDL (you'll need to copy this from your types/carbon.ts file)
// For now, we'll load it from a JSON file
function loadIDL() {
  try {
    const idlPath = path.join(__dirname, '..', 'idl', 'carbon.json');
    return JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  } catch (error) {
    console.error('Error loading IDL. Please ensure carbon.json exists in the idl/ directory');
    console.error('You can export your IDL from the Rust project using: anchor build && anchor extract-idl carbon');
    throw error;
  }
}

// Helper functions to find PDAs
function findGlobalPDA(admin) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global'), admin.toBuffer()],
    PROGRAM_ID
  );
}

function findActionTypePDA(global, slug) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('action_type'), global.toBuffer(), Buffer.from(slug)],
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

async function loadWallet() {
  // Option 1: Load from Solana CLI (if you have it configured)
  try {
    const keypairPath = path.join(require('os').homedir(), '.config', 'solana', 'id.json');
    if (fs.existsSync(keypairPath)) {
      const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
      return Keypair.fromSecretKey(new Uint8Array(secretKey));
    }
  } catch (error) {
    console.log('Could not load from Solana CLI config');
  }

  // Option 2: Load from environment variable
  if (process.env.SOLANA_PRIVATE_KEY) {
    try {
      const secretKey = JSON.parse(process.env.SOLANA_PRIVATE_KEY);
      return Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch (error) {
      console.error('Invalid SOLANA_PRIVATE_KEY format');
    }
  }

  // Option 3: Load from local file
  const localKeypairPath = path.join(__dirname, 'admin-keypair.json');
  if (fs.existsSync(localKeypairPath)) {
    const secretKey = JSON.parse(fs.readFileSync(localKeypairPath, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  }

  throw new Error(`
No wallet found. Please provide your admin wallet in one of these ways:
1. Set SOLANA_PRIVATE_KEY environment variable with your secret key array
2. Create admin-keypair.json in the scripts/ directory with your secret key
3. Configure Solana CLI with your keypair

Example admin-keypair.json format:
[123,45,67,89,...] (array of 64 numbers)

Example environment variable:
export SOLANA_PRIVATE_KEY='[123,45,67,89,...]'
  `);
}

async function initializeProgram() {
  console.log('🚀 Initializing Carbon Credits Program...');
  console.log(`Network: ${NETWORK}`);
  console.log(`Program ID: ${PROGRAM_ID.toString()}`);

  // Load wallet
  const adminKeypair = await loadWallet();
  console.log(`Admin wallet: ${adminKeypair.publicKey.toString()}`);

  // Check wallet balance
  const balance = await connection.getBalance(adminKeypair.publicKey);
  console.log(`Wallet balance: ${balance / 1e9} SOL`);
  
  if (balance < 0.1 * 1e9) {
    console.warn('⚠️  Low SOL balance. You may need more SOL for transactions.');
  }

  // Setup Anchor
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const idl = loadIDL();
  const program = new anchor.Program(idl, PROGRAM_ID, provider);

  // Find the global PDA
  const [globalPDA, globalBump] = findGlobalPDA(adminKeypair.publicKey);
  console.log(`Global PDA: ${globalPDA.toString()}`);

  // Check if already initialized
  try {
    const existingGlobal = await program.account.globalState.fetch(globalPDA);
    console.log('✅ Program already initialized!');
    console.log('Global state:', {
      admin: existingGlobal.admin.toString(),
      pointsMint: existingGlobal.pointsMint.toString(),
      vault: existingGlobal.vault.toString(),
      verifiers: existingGlobal.verifiers.map(v => v.toString()),
      paused: existingGlobal.params.paused,
    });
    return;
  } catch (error) {
    console.log('Program not initialized yet, proceeding...');
  }

  console.log('📝 Creating points mint...');
  
  // Create points mint with Global PDA as authority
  const pointsMint = await createMint(
    connection,
    adminKeypair,
    globalPDA, // Global PDA will be the mint authority
    null, // No freeze authority
    6, // 6 decimals
    undefined,
    { commitment: 'confirmed' },
    TOKEN_PROGRAM_ID
  );

  console.log(`✅ Points mint created: ${pointsMint.toString()}`);

  // Create vault token account
  console.log('📝 Creating vault account...');
  const vaultAccount = await createAccount(
    connection,
    adminKeypair,
    pointsMint,
    globalPDA,
    undefined,
    { commitment: 'confirmed' },
    TOKEN_PROGRAM_ID
  );

  console.log(`✅ Vault account created: ${vaultAccount.toString()}`);

  // Initialize global state
  console.log('📝 Initializing global state...');
  const verifiers = [adminKeypair.publicKey]; // Admin is also a verifier for MVP
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
        admin: adminKeypair.publicKey,
        global: globalPDA,
        pointsMint: pointsMint,
        vault: vaultAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log(`✅ Global state initialized! Transaction: ${tx}`);

    // Wait for confirmation
    await connection.confirmTransaction(tx, 'confirmed');

  } catch (error) {
    console.error('❌ Error initializing global state:', error);
    throw error;
  }

  // Register action types
  console.log('📝 Registering action types...');
  await registerActionTypes(program, adminKeypair.publicKey, globalPDA);

  console.log('🎉 Program initialization complete!');
  console.log('\n📋 Summary:');
  console.log(`- Admin: ${adminKeypair.publicKey.toString()}`);
  console.log(`- Global PDA: ${globalPDA.toString()}`);
  console.log(`- Points Mint: ${pointsMint.toString()}`);
  console.log(`- Vault: ${vaultAccount.toString()}`);
  console.log(`- Network: ${NETWORK}`);
}

async function registerActionTypes(program, admin, globalPDA) {
  const actionTypes = [
    {
      slug: 'tree_planting',
      name: 'Tree Planting',
      pointsPerUnit: 100,
      unit: 0, // 0 = tree
      badgeUri: 'https://example.com/tree-badge',
      cooldownSecs: 3600, // 1 hour
      perTxCap: 10, // max 10 trees per transaction
    },
    // Add more action types here if needed
    // {
    //   slug: 'waste_collection',
    //   name: 'Waste Collection',
    //   pointsPerUnit: 50,
    //   unit: 1, // 1 = kg
    //   badgeUri: 'https://example.com/waste-badge',
    //   cooldownSecs: 1800, // 30 minutes
    //   perTxCap: 20, // max 20 kg per transaction
    // },
  ];

  for (const actionType of actionTypes) {
    const slug = stringToSlug(actionType.slug);
    const [actionTypePDA] = findActionTypePDA(globalPDA, slug);

    try {
      // Check if action type already exists
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
      
      // Wait for confirmation
      await connection.confirmTransaction(tx, 'confirmed');
      
    } catch (error) {
      console.error(`❌ Error registering '${actionType.name}' action type:`, error);
    }
  }
}

// Run the initialization
if (require.main === module) {
  initializeProgram()
    .then(() => {
      console.log('\n✨ Initialization completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Initialization failed:', error.message);
      process.exit(1);
    });
}

module.exports = { initializeProgram };