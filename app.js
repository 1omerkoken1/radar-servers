const WebSocket = require('ws');
const http = require('http');

// Render portunu veya varsayılan 10000 portunu kullanır
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Radar Sunucusu Aktif ve Canlı');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Yeni bir cihaz baglandi.');

  ws.on('message', (message) => {
    // Bir cihazdan gelen konumu veya veriyi bagli olan diger herkese yayar
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('Bir cihaz ayrildi.');
  });
});

server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda basariyla baslatildi.`);
});
