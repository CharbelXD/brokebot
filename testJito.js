const WebSocket = require('ws');

const url = 'wss://mainnet.block-engine.jito.wtf';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('✅ WebSocket connected to', url);
  ws.terminate();
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
});
