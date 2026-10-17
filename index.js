const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

// --- GANTI DENGAN DOMAIN INFINITYFREE KAMU ---
const CRM_WEBHOOK_URL = 'https://desktop-suitable-doze.ngrok-free.dev/wa-crm/webhook.php';

let sock;
let qrCodeData = '';
let connectionStatus = 'Connecting';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'QR Generated';
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba menghubungkan kembali...', shouldReconnect);
            connectionStatus = 'Disconnected';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Berhasil Terhubung!');
            connectionStatus = 'Connected';
            qrCodeData = '';
        }
    });

    // Tangkap Pesan Masuk & Teruskan ke CRM PHP (Dilengkapi Debug Respon)
   sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
        
        // 1. Ekstrak JID asli (Handle jika mendapat @lid / LID acak)
        let rawJid = msg.key.remoteJid || '';
        
        // Jika remoteJid berbentuk @lid, coba ambil alternatif phone number JID jika ada
        if (rawJid.includes('@lid') && msg.key.participant) {
            rawJid = msg.key.participant;
        }

        // Ambil hanya angkanya saja
        let sender = rawJid.split('@')[0].split(':')[0];

        // 2. Jika sender masih berupa LID acak (panjang > 13 digit dan bukan diawali 62/0), 
        // pastikan tidak merusak format HP, tapi jika diawali 62, ubah ke 08...
        if (sender.startsWith('62')) {
            sender = '0' + sender.slice(2);
        }

        const message = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.imageMessage?.caption || '';
                        
        const pushName = msg.pushName || 'Prospek WA';

        if (message && sender) {
            try {
                const response = await axios.post(CRM_WEBHOOK_URL, {
                    sender: sender,
                    message: message,
                    name: pushName
                });
                console.log(`[Webhook] Pesan dari ${sender} berhasil dikirim ke PHP CRM.`);
            } catch (error) {
                console.error('[Webhook Error] Gagal kirim ke CRM:', error.message);
            }
        }
    }
});
}

// Endpoint untuk menampilkan halaman /qr di Browser / Iframe CRM
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'Connected') {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; color:green; margin-top:50px;">✔ WhatsApp Anda sudah terhubung!</h3>');
    }
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; color:gray; margin-top:50px;">⏳ QR Code sedang disiapkan, muat ulang halaman...</h3><script>setTimeout(() => location.reload(), 3000);</script>');
    }
    try {
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:30px;">
                <h3>Scan QR Code WhatsApp</h3>
                <img src="${qrImage}" style="width:280px; height:280px;" />
                <p style="color:gray; font-size:12px;">Scan menggunakan aplikasi WhatsApp di HP Anda</p>
                <script>setTimeout(() => location.reload(), 20000);</script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Gagal memuat QR Code');
    }
});

// Endpoint untuk mengirim pesan balasan dari CRM PHP (Dilengkapi Auto-Format Nomor 62)
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ status: false, message: 'Nomor dan pesan wajib diisi' });
    }

    try {
        // Bersihkan semua karakter non-angka
        let cleanPhone = phone.replace(/\D/g, '');

        // UBAH FORMAT: Jika dari PHP masuk '08...', ubah jadi '628...'
        if (cleanPhone.startsWith('0')) {
            cleanPhone = '62' + cleanPhone.slice(1);
        }

        // Susun JID akhir untuk Baileys
        const targetJid = cleanPhone.includes('@s.whatsapp.net') || cleanPhone.includes('@lid') 
            ? cleanPhone 
            : `${cleanPhone}@s.whatsapp.net`;

        console.log(`Mencoba mengirim pesan ke JID: ${targetJid}`);

        // Kirim via Baileys
        await sock.sendMessage(targetJid, { text: message });
        
        console.log(`[Sukses] Pesan terkirim ke ${targetJid}`);
        return res.json({ status: true, message: 'Pesan berhasil dikirim' });

    } catch (error) {
        console.error('[Error /send]:', error);
        return res.status(500).json({ status: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server WA Gateway berjalan di port ${PORT}`);
    connectToWhatsApp();
});
