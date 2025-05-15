const { Connection } = require("@solana/web3.js");
const mongoose = require('mongoose');
require('dotenv').config();

const config = {
    // rpc: 'https://mainnet.helius-rpc.com/?api-key=6ade3723-07c0-4936-a748-a73d1d36ffae',
    // rpc: 'https://go.getblock.io/c9837f30112a402c9883fd95616b3785',
    // rpc: 'https://solana-mainnet.core.chainstack.com/105286c92d78bd3cbcef3a30cb2f6d81',
     rpc: 'https://little-capable-dream.solana-mainnet.quiknode.pro/d3c1f6637adf56f528716f4ce5c34e177bb24db6/',
    rpc: 'https://mainnet.helius-rpc.com/?api-key=b8958924-1fba-40a9-8f4c-81979fb8a4c7',
    tax_wallet: 'fuckvxMkcK3UCQ5WUGrxs2mcz1U2oXjnk5M5J8UQH2K',
    poolTax: 1, // 5%
    botTax: 0.001, // .01%
    walletLimit: 4
}

const connection = new Connection(config.rpc, 'confirmed');

// MongoDB connection using Mongoose
async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
}

module.exports = {connection, config, connectDB};