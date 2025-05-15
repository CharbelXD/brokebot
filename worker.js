const { parentPort, workerData } = require('worker_threads');
const Task = require('./models/taskModel');
const User = require('./models/userModel');
const { connectDB, connection, config } = require('./config');
const {
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  Keypair,
  PublicKey,
  SystemProgram,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require('@solana/spl-token');
const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const { getPrice } = require('./helpers/walletHelper');

dotenv.config();
connectDB();

const bot = new TelegramBot(process.env.BOT_TOKEN);
const NATIVE_TOKEN = "So11111111111111111111111111111111111111112";
const EXCLUDE_DEXES = [
  "Saber", "Cropper", "Phoenix", "Bonkswap", "Orca V1", "Mercurial", "Lifinity", "Openbook"
];

async function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchWithRetry(url, opts = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      const delayMs = 500 * Math.pow(2, i);
      console.warn(`429 Too Many Requests. Retrying after ${delayMs}ms...`);
      await delay(delayMs);
    } else {
      return res;
    }
  }
  throw new Error("Too many retries");
}

async function swapQuote(token, amount, isBuy, slippage = 50) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${isBuy ? NATIVE_TOKEN : token}&outputMint=${!isBuy ? NATIVE_TOKEN : token}&amount=${amount}&slippageBps=${slippage}&excludeDexes=${EXCLUDE_DEXES.join(',')}`;
    const res = await fetchWithRetry(url);
    return await res.json();
  } catch (error) {
    console.error("Quote error:", error);
    return null;
  }
}

async function ensureATAExists(mint, wallet, instructions) {
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const info = await connection.getAccountInfo(ata);
  const walletBalance = await connection.getBalance(wallet.publicKey);
if (walletBalance < 0.004 * LAMPORTS_PER_SOL) {
  console.warn("⚠️ Not enough SOL to create ATA.");
  return false; // Skip ATA setup
}


  if (!info) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        mint
      )
    );
  }
  return ata;
}

async function swap(quote, wallet) {
  try {
    const res = await fetchWithRetry('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    const data = await res.json();
    if (!data.swapTransaction) return null;

    const txBuffer = Buffer.from(data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([wallet]);
    return tx;
  } catch (err) {
    console.error("Swap error:", err);
    return null;
  }
}

async function pooler() {
  try {
    let task = await Task.findOne({ taskid: workerData[0] });
    const user = await User.findOne({ userid: task.userid });
    const token = new PublicKey(workerData[1]);
    const wallet = Keypair.fromSecretKey(new Uint8Array(user.private_key.split(',').map(Number)));
    const swapAmount = 66000; // ≈ $0.01 worth of SOL at $150/SOL
    const RENT_EXEMPT_LAMPORTS = 0.0025 * LAMPORTS_PER_SOL; // ~0.0025 SOL per ATA
const minRequired = swapAmount + RENT_EXEMPT_LAMPORTS * 2 + (0.002 * LAMPORTS_PER_SOL); // + tip/tx cost

    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < minRequired) {
      await Task.updateOne({ taskid: task.taskid }, { isRunning: false });
      return bot.sendMessage(user.userid, `⭕ <code>${task.token}</code> - Insufficient balance (need ${(minRequired / LAMPORTS_PER_SOL).toFixed(3)} SOL).`, { parse_mode: 'HTML' });
    }

    while (true) {
      task = await Task.findOne({ taskid: workerData[0] });
      if (!task.isRunning) {
        await delay(5000);
        continue;
      }

      if (task.volumeMade >= task.target) {
        await Task.updateOne({ taskid: task.taskid }, { isRunning: false });
        bot.sendMessage(user.userid, `🚀 <code>${task.token}</code> - Target Reached`, { parse_mode: 'HTML' });
        break;
      }

      const buyQuote = await swapQuote(token, swapAmount, true);
      if (!buyQuote) continue;

      // Pre-create ATA if needed
      const ataInstructions = [];
      await ensureATAExists(new PublicKey(buyQuote.outputMint), wallet, ataInstructions);
      if (ataInstructions.length > 0) {
        const latestBlockhash = await connection.getLatestBlockhash();
        const setupTx = new VersionedTransaction(
          new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: ataInstructions,
          }).compileToV0Message()
        );
        setupTx.sign([wallet]);
        await connection.sendTransaction(setupTx);
      }

      const buyTx = await swap(buyQuote, wallet);
      if (!buyTx) continue;

      const sellQuote = await swapQuote(token, buyQuote.outAmount ?? swapAmount, false);
      const sellTx = await swap(sellQuote, wallet);
      if (!sellTx) continue;

      try {
        await connection.sendTransaction(buyTx);
        await connection.sendTransaction(sellTx);

        const latestBlockhash = await connection.getLatestBlockhash();
        const taxIx = SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(config.tax_wallet),
          lamports: Math.floor(swapAmount * 2 * config.botTax),
        });

        const message = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [taxIx],
        }).compileToV0Message();

        const taxTx = new VersionedTransaction(message);
        taxTx.sign([wallet]);
        await connection.sendTransaction(taxTx);

        const usd = getPrice(swapAmount / LAMPORTS_PER_SOL) * 2;
        await Task.updateOne({ taskid: task.taskid }, { $inc: { volumeMade: usd } });

        bot.sendMessage(user.userid, `✅ Round completed: ${(swapAmount / LAMPORTS_PER_SOL).toFixed(3)} SOL`, { parse_mode: 'HTML' });
      } catch (err) {
        console.error("❌ Swap or tax failed:", err.message);
      }

      await delay(1000);
    }
  } catch (err) {
    console.error("❌ Worker fatal error:", err);
    await Task.updateOne({ taskid: workerData[0] }, { isRunning: false });
    
  }bot.sendMessage(user.userid, '❌ Bot stopped due to error.');
}

pooler();
