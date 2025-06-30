// ===================================
// SERVER.JS - Backend Completo per Render
// ===================================

const express = require('express');
const { Pool } = require('pg');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS per sviluppo
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
});

// ===================================
// DATABASE CONNECTION
// ===================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test connessione database
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Errore connessione database:', err);
    } else {
        console.log('✅ Database connesso con successo');
        release();
    }
});

// ===================================
// HEALTH CHECK (necessario per Render)
// ===================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        service: 'Agente Telefonico Contatori'
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Agente Telefonico Contatori - API Online',
        version: '1.0.0',
        endpoints: [
            '/health', 
            '/api/search-appointment', 
            '/api/confirm-appointment', 
            '/api/reschedule-appointment',
            '/api/get-info'
        ]
    });
});

// ===================================
// WEBHOOK VOIP.MS/TWILIO
// ===================================
app.post('/voice', async (req, res) => {
    console.log('📞 Chiamata ricevuta:', req.body);
    
    // Risposta TwiML per Twilio/VOIP.ms
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Giorgio" language="it-IT">
        Buongiorno, sono l'assistente per gli appuntamenti di sostituzione contatori. 
        Per aiutarla, ho bisogno della matricola del contatore riportata nella comunicazione che le abbiamo inviato.
    </Say>
    <Gather input="speech" speechTimeout="5" action="/process-matricola" method="POST">
        <Say voice="Polly.Giorgio" language="it-IT">
            Mi può fornire la matricola del contatore per favore?
        </Say>
    </Gather>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// ===========================================
// Funzione per inviare SMS tramite GatewayAPI
// ===========================================
async function sendSMSToOperator(operatorPhone, message) {
    try {
        const response = await fetch('https://gatewayapi.com/rest/mtsms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.qsKnr3jISnKqJRSs_HawaUyEQjTpkhLYFVjbEzRc3swX4haONb_IZZkUx7hB3cF-}`
            },
            body: JSON.stringify({
                sender: process.env.GATEWAYAPI_SENDER,
                message: message,
                recipients: [{ msisdn: operatorPhone }]
            })
        });

        const result = await response.json();
        console.log('📱 SMS inviato:', result);
        return result;
    } catch (error) {
        console.error('❌ Errore invio SMS:', error);
        return null;
    }
}

// ===================================
// API PER ELEVENLABS FUNCTIONS
// ===================================

// Funzione 1: Cerca appuntamento per matricola
app.post('/api/search-appointment', async (req, res) => {
    try {
        console.log('🔍 Ricerca appuntamento:', req.body);
        const { matricola } = req.body;
        
        if (!matricola) {
            return res.status(400).json({
                success: false,
                error: 'Matricola richiesta'
            });
        }
        
        const query = `
            SELECT 
                p.id,
                p.nome_utente,
                p.indirizzo,
                p.comune,
                p.matricola,
                p.pdr_pdp,
                p.data_appuntamento,
                p.fascia_oraria,
                p.telefono,
                c.tipo_attivita,
                c.committente,
                o.nome as operatore_nome,
                o.cognome as operatore_cognome
            FROM pianificazioni p
            LEFT JOIN commesse c ON p.commessa_id = c.id
            LEFT JOIN operatori o ON p.operatore_id = o.id
            WHERE p.matricola = $1
            ORDER BY p.data_appuntamento DESC
            LIMIT 1
        `;
        
        const result = await pool.query(query, [matricola]);
        
        if (result.rows.length === 0) {
            return res.json({
                success: false,
                found: false,
                message: `Non ho trovato alcun appuntamento per la matricola ${matricola}. Può verificare che sia corretta? La matricola si trova nella comunicazione che le abbiamo inviato.`
            });
        }
        
        const appointment = result.rows[0];
        const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            found: true,
            appointment: {
                id: appointment.id,
                nome: appointment.nome_utente,
                indirizzo: appointment.indirizzo,
                comune: appointment.comune,
                matricola: appointment.matricola,
                data: dataFormatted,
                fascia_oraria: appointment.fascia_oraria,
                tipo_attivita: appointment.tipo_attivita,
                committente: appointment.committente,
                operatore: appointment.operatore_nome ? 
                    `${appointment.operatore_nome} ${appointment.operatore_cognome}` : 
                    'Da assegnare',
                telefono: appointment.telefono
            },
            message: `Perfetto! Ho trovato il suo appuntamento per ${appointment.tipo_attivita} presso ${appointment.indirizzo}, ${appointment.comune}. L'appuntamento è programmato per ${dataFormatted} nella fascia oraria ${appointment.fascia_oraria}.`
        });
        
    } catch (error) {
        console.error('❌ Errore ricerca appuntamento:', error);
        res.status(500).json({
            success: false,
            error: 'Errore interno del sistema. Riprovi tra poco.',
            details: error.message
        });
    }
});

// Funzione 2: Conferma appuntamento
app.post('/api/confirm-appointment', async (req, res) => {
    try {
        console.log('✅ Conferma appuntamento:', req.body);
        const { appointment_id, matricola } = req.body;
        
        // Aggiungi campo stato se non esiste
        try {
            await pool.query(`
                ALTER TABLE pianificazioni 
                ADD COLUMN IF NOT EXISTS stato VARCHAR(50) DEFAULT 'programmato'
            `);
        } catch (alterError) {
            // Ignora errore se colonna già esiste
        }
        
        const updateQuery = `
            UPDATE pianificazioni 
            SET stato = 'confermato'
            WHERE id = $1 OR matricola = $2
            RETURNING *
        `;
        
        const result = await pool.query(updateQuery, [appointment_id, matricola]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const appointment = result.rows[0];
        const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Il suo appuntamento per ${dataFormatted} nella fascia oraria ${appointment.fascia_oraria} è stato confermato. I nostri tecnici si presenteranno nell'orario concordato. Ha altre domande?`
        });
        
    } catch (error) {
        console.error('❌ Errore conferma appuntamento:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la conferma. Riprovi tra poco.'
        });
    }
});

// Funzione 3: Riprogramma appuntamento
app.post('/api/reschedule-appointment', async (req, res) => {
    try {
        console.log('📅 Riprogrammazione appuntamento:', req.body);
        const { appointment_id, matricola, new_date, new_time_slot, reason } = req.body;
        
        // Verifica disponibilità (semplificata)
        const availabilityQuery = `
            SELECT COUNT(*) as count 
            FROM pianificazioni 
            WHERE data_appuntamento = $1 
            AND fascia_oraria = $2
        `;
        
        const availability = await pool.query(availabilityQuery, [new_date, new_time_slot]);
        
        if (parseInt(availability.rows[0].count) >= 5) { // Max 5 appuntamenti per slot
            return res.json({
                success: false,
                error: 'La fascia oraria richiesta è già piena. Le propongo alternative disponibili.',
                alternatives: [
                    { date: new_date, time: '08:00-12:00' },
                    { date: new_date, time: '13:00-17:00' }
                ]
            });
        }
        
        // Aggiorna appuntamento
        const updateQuery = `
            UPDATE pianificazioni 
            SET data_appuntamento = $1,
                fascia_oraria = $2,
                stato = 'riprogrammato'
            WHERE id = $3 OR matricola = $4
            RETURNING *
        `;
        
        const result = await pool.query(updateQuery, [
            new_date, 
            new_time_slot, 
            appointment_id,
            matricola
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const newDateFormatted = new Date(new_date).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Ho spostato il suo appuntamento al ${newDateFormatted} nella fascia oraria ${new_time_slot}. L'appuntamento precedente è stato cancellato. Desidera altro?`
        });
        
    } catch (error) {
        console.error('❌ Errore riprogrammazione:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la riprogrammazione. Riprovi tra poco.'
        });
    }
});

// Funzione 4: Informazioni generali
app.post('/api/get-info', async (req, res) => {
    try {
        const { topic } = req.body;
        
        const info = {
            'durata_intervento': 'L\'intervento di sostituzione contatore richiede normalmente 20-25 minuti con una breve interruzione del servizio di circa 15-20 minuti.',
            'cosa_portare': 'È necessario che lei sia presente durante l\'intervento solo per contatori non accessivili e che l\'area del contatore sia facilmente accessibile. I tecnici potrebbero richiederle un documento d\'identità.',
            'costi': 'L\'intervento di sostituzione programmato è completamente gratuito e obbligatorio secondo normativa.',
            'sicurezza': 'I nostri tecnici seguono tutti i protocolli di sicurezza e sono dotati di dispositivi di protezione. L\'intervento è completamente sicuro.',
            'dopo_intervento': 'Dopo la sostituzione il servizio sarà immediatamente ripristinato.',
            'contatti': 'Per emergenze può contattare il nostro numero verde 353-3331878.'
        };
        
        res.json({
            success: true,
            info: info[topic] || 'Informazione non disponibile. Può contattare il nostro ufficio per maggiori dettagli.',
            message: info[topic] || 'Per questa informazione specifica la invito a contattare direttamente il nostro ufficio tecnico.'
        });
        
    } catch (error) {
        console.error('❌ Errore recupero informazioni:', error);
        res.status(500).json({
            success: false,
            error: 'Errore nel recupero informazioni'
        });
    }
});

// ===================================
// ENDPOINT UTILITÀ
// ===================================

// Lista appuntamenti (per testing)
app.get('/api/appointments', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, c.tipo_attivita, c.committente 
            FROM pianificazioni p
            LEFT JOIN commesse c ON p.commessa_id = c.id
            ORDER BY p.data_appuntamento DESC
            LIMIT 50
        `);
        
        res.json({
            success: true,
            appointments: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Inserisci appuntamento di test
app.post('/api/test-appointment', async (req, res) => {
    try {
        const result = await pool.query(`
            INSERT INTO pianificazioni 
            (nome_utente, indirizzo, comune, matricola, pdr_pdp, data_appuntamento, fascia_oraria, telefono)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            'Mario Rossi Test',
            'Via Roma 123',
            'Milano',
            'TEST123456',
            'PDR123456',
            '2024-07-25',
            '09:00-12:00',
            '3331234567'
        ]);
        
        res.json({
            success: true,
            message: 'Appuntamento di test creato',
            appointment: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===================================
// KEEP-ALIVE per hosting gratuito
// ===================================
if (process.env.NODE_ENV === 'production') {
    setInterval(async () => {
        try {
            const { default: fetch } = await import('node-fetch');
            const baseUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
            await fetch(`${baseUrl}/health`);
            console.log('🏓 Keep-alive ping sent');
        } catch (error) {
            console.log('❌ Keep-alive failed:', error.message);
        }
    }, 10 * 60 * 1000); // Ogni 10 minuti
}

// ===================================
// START SERVER
// ===================================
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Server avviato sulla porta ${PORT}
📞 Webhook disponibile su: /voice
🔧 API disponibili su: /api/*
💚 Health check: /health
🗄️  Database: Connesso a PostgreSQL
🌐 Environment: ${process.env.NODE_ENV || 'development'}
    `);
});

// Gestione graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM ricevuto, chiusura server...');
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT ricevuto, chiusura server...');
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});
