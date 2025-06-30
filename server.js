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

// ===================================
// AGGIUNGI QUESTE FUNZIONI AL TUO SERVER.JS ESISTENTE
// ===================================

// Funzione per cercare telefono operatore tramite nome completo
async function getOperatorPhone(operatorFullName) {
    try {
        if (!operatorFullName) return null;
        
        // Split "Nome Cognome" in parti separate
        const nameParts = operatorFullName.trim().split(' ');
        
        if (nameParts.length < 2) {
            console.log('⚠️ Formato operatore non valido:', operatorFullName);
            return null;
        }
        
        const nome = nameParts[0];
        const cognome = nameParts.slice(1).join(' '); // Per gestire cognomi composti
        
        console.log(`🔍 Ricerca operatore: nome="${nome}", cognome="${cognome}"`);
        
        // Query per trovare l'operatore
        const operatorQuery = `
            SELECT telefono, nome, cognome
            FROM operatori 
            WHERE LOWER(nome) = LOWER($1) 
            AND LOWER(cognome) = LOWER($2)
            LIMIT 1
        `;
        
        const result = await pool.query(operatorQuery, [nome, cognome]);
        
        if (result.rows.length > 0) {
            const operator = result.rows[0];
            console.log(`✅ Operatore trovato: ${operator.nome} ${operator.cognome}, tel: ${operator.telefono}`);
            return operator.telefono;
        } else {
            console.log(`❌ Operatore non trovato: ${nome} ${cognome}`);
            return null;
        }
        
    } catch (error) {
        console.error('❌ Errore ricerca operatore:', error);
        return null;
    }
}

app.post('/api/confirm-appointment', async (req, res) => {
    try {
        console.log('✅ Conferma appuntamento:', req.body);
        const { appointment_id, matricola } = req.body;
        
        // QUERY MODIFICATA: leggi operatore_id come nome completo
        const appointmentQuery = `
            SELECT 
                p.*,
                p.operatore_id as operatore_nome_completo
            FROM pianificazioni p
            WHERE p.id = $1 OR p.matricola = $2
        `;
        
        const appointmentResult = await pool.query(appointmentQuery, [appointment_id, matricola]);
        
        if (appointmentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const appointment = appointmentResult.rows[0];
        
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
        
        // NUOVO: Cerca telefono operatore e invia SMS
        let smsStatus = 'nessun operatore';
        if (appointment.operatore_nome_completo) {
            const operatorPhone = await getOperatorPhone(appointment.operatore_nome_completo);
            
            if (operatorPhone) {
                const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
                const smsMessage = `✅ APPUNTAMENTO CONFERMATO
Cliente: ${appointment.nome_utente}
Indirizzo: ${appointment.indirizzo}, ${appointment.comune}
Matricola: ${appointment.matricola}
Data: ${dataFormatted} ore ${appointment.fascia_oraria}
Il cliente ha confermato telefonicamente.`;

                const smsResult = await sendSMSToOperator(operatorPhone, smsMessage);
                smsStatus = smsResult ? 'SMS inviato' : 'SMS fallito';
            } else {
                smsStatus = 'operatore non trovato';
            }
        }
        
        const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Il suo appuntamento per ${dataFormatted} nella fascia oraria ${appointment.fascia_oraria} è stato confermato. ${smsStatus === 'SMS inviato' ? 'Il nostro operatore è stato notificato e' : ''} I nostri tecnici si presenteranno nell'orario concordato. Ha altre domande?`
        });
        
    } catch (error) {
        console.error('❌ Errore conferma appuntamento:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la conferma. Riprovi tra poco.'
        });
    }
});

// SOSTITUISCI la tua funzione reschedule-appointment con questa:
app.post('/api/reschedule-appointment', async (req, res) => {
    try {
        console.log('📅 Riprogrammazione appuntamento:', req.body);
        const { appointment_id, matricola, new_date, new_time_slot, reason } = req.body;
        
        // QUERY MODIFICATA: leggi operatore_id come nome completo
        const appointmentQuery = `
            SELECT 
                p.*,
                p.operatore_id as operatore_nome_completo
            FROM pianificazioni p
            WHERE p.id = $1 OR p.matricola = $2
        `;
        
        const appointmentResult = await pool.query(appointmentQuery, [appointment_id, matricola]);
        
        if (appointmentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const appointment = appointmentResult.rows[0];
        
        // Verifica disponibilità (come prima)
        const availabilityQuery = `
            SELECT COUNT(*) as count 
            FROM pianificazioni 
            WHERE data_appuntamento = $1 
            AND fascia_oraria = $2
        `;
        
        const availability = await pool.query(availabilityQuery, [new_date, new_time_slot]);
        
        if (parseInt(availability.rows[0].count) >= 5) {
            return res.json({
                success: false,
                error: 'La fascia oraria richiesta è già piena. Le propongo alternative disponibili.',
                alternatives: [
                    { date: new_date, time: '08:00-12:00' },
                    { date: new_date, time: '13:00-17:00' }
                ]
            });
        }
        
        // Aggiorna appuntamento (come prima)
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
        
        // NUOVO: Cerca telefono operatore e invia SMS
        let smsStatus = 'nessun operatore';
        if (appointment.operatore_nome_completo) {
            const operatorPhone = await getOperatorPhone(appointment.operatore_nome_completo);
            
            if (operatorPhone) {
                const oldDateFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
                const newDateFormatted = new Date(new_date).toLocaleDateString('it-IT');
                const smsMessage = `🔄 APPUNTAMENTO MODIFICATO
Cliente: ${appointment.nome_utente}
Indirizzo: ${appointment.indirizzo}, ${appointment.comune}
Matricola: ${appointment.matricola}
VECCHIO: ${oldDateFormatted} ore ${appointment.fascia_oraria}
NUOVO: ${newDateFormatted} ore ${new_time_slot}
Motivo: ${reason || 'Richiesta cliente'}`;

                const smsResult = await sendSMSToOperator(operatorPhone, smsMessage);
                smsStatus = smsResult ? 'SMS inviato' : 'SMS fallito';
            } else {
                smsStatus = 'operatore non trovato';
            }
        }
        
        const newDateFormatted = new Date(new_date).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Ho spostato il suo appuntamento al ${newDateFormatted} nella fascia oraria ${new_time_slot}. Riceverà una nuova comunicazione con i dettagli aggiornati. ${smsStatus === 'SMS inviato' ? 'Il nostro operatore è stato notificato della modifica.' : ''} Desidera altro?`
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
            'durata_intervento': 'L\'intervento di sostituzione contatore richiede normalmente 30-45 minuti con una breve interruzione del servizio di circa 15-20 minuti.',
            'cosa_portare': 'È necessario che lei sia presente durante l\'intervento e che l\'area del contatore sia facilmente accessibile. I tecnici potrebbero richiederle un documento d\'identità.',
            'costi': 'L\'intervento di sostituzione programmato è completamente gratuito e obbligatorio secondo normativa.',
            'sicurezza': 'I nostri tecnici seguono tutti i protocolli di sicurezza e sono dotati di dispositivi di protezione. L\'intervento è completamente sicuro.',
            'dopo_intervento': 'Dopo la sostituzione riceverà un certificato di conformità e il servizio sarà immediatamente ripristinato.',
            'contatti': 'Per emergenze può contattare il nostro numero verde 800-123456 attivo 24 ore su 24.'
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
// NUOVA FUNZIONE: GET CURRENT DATE + VALIDATE DATES
// ===================================

// Funzione 5: Ottieni data corrente (VERSIONE AGGIORNATA)
app.post('/api/get-current-date', async (req, res) => {
    try {
        const today = new Date();
        const todayString = today.toISOString().split('T')[0];
        const todayFormatted = today.toLocaleDateString('it-IT');
        
        const availableDates = [];
        
        // Genera prossimi 30 giorni disponibili (escludendo SOLO domenica)
        for (let i = 1; i <= 30; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() + i);
            
            const dayOfWeek = date.getDay(); // 0 = Domenica, 6 = Sabato
            
            // Escludi SOLO domenica (0), sabato (6) è permesso
            if (dayOfWeek !== 0) {
                availableDates.push({
                    date: date.toISOString().split('T')[0],
                    formatted: date.toLocaleDateString('it-IT'),
                    dayName: date.toLocaleDateString('it-IT', { weekday: 'long' })
                });
            }
        }

        res.json({
            success: true,
            current_date: todayString,
            current_date_formatted: todayFormatted,
            message: `Oggi è ${todayFormatted}. Gli appuntamenti possono essere fissati da domani in poi (esclusa la domenica).`,
            available_dates: availableDates.slice(0, 10),
            time_slots: [
                '08:00-12:00',
                '09:00-12:00',
                '13:00-17:00',
                '14:00-17:00',
                '14:00-18:00'
            ]
        });
        
    } catch (error) {
        console.error('❌ Errore get current date:', error);
        res.status(500).json({
            success: false,
            error: 'Errore nel recupero data corrente'
        });
    }
});

// Funzione 6: Valida data proposta dal cliente (VERSIONE SEMPLIFICATA)
app.post('/api/validate-appointment-date', async (req, res) => {
    try {
        const { proposed_date, time_slot } = req.body;
        
        if (!proposed_date) {
            return res.status(400).json({
                success: false,
                error: 'Data proposta richiesta'
            });
        }
        
        const today = new Date();
        const proposedDate = new Date(proposed_date);
        
        // CONTROLLO 1: Verifica che la data non sia nel passato
        if (proposedDate <= today) {
            return res.json({
                success: false,
                is_valid: false,
                reason: 'past_date',
                message: `Mi dispiace, non posso fissare appuntamenti nel passato. Oggi è ${today.toLocaleDateString('it-IT')}. Le posso proporre una data da domani in poi.`,
                suggested_dates: await getSuggestedDates()
            });
        }
        
        // CONTROLLO 2: Verifica che non sia domenica
        const dayOfWeek = proposedDate.getDay();
        if (dayOfWeek === 0) { // Solo domenica (0), sabato (6) è permesso
            return res.json({
                success: false,
                is_valid: false,
                reason: 'sunday',
                message: 'Non effettuiamo interventi di domenica. Le posso proporre il lunedì successivo o un altro giorno.',
                suggested_dates: await getSuggestedDates()
            });
        }
        
        // RIMUOVO: Controllo disponibilità slot - non serve più
        // La data è valida se non è nel passato e non è domenica
        
        res.json({
            success: true,
            is_valid: true,
            message: `Perfetto! La data ${proposedDate.toLocaleDateString('it-IT')} è disponibile.`,
            available_time_slots: [
                '08:00-12:00',
                '09:00-12:00',
                '13:00-17:00',
                '14:00-17:00',
                '14:00-18:00'
            ]
        });
        
    } catch (error) {
        console.error('❌ Errore validazione data:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la validazione'
        });
    }
});

// ===================================
// ANCHE QUESTA HELPER FUNCTION VA AGGIORNATA
// ===================================

// Helper function per date suggerite (VERSIONE AGGIORNATA)
async function getSuggestedDates() {
    const today = new Date();
    const suggested = [];
    
    for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() + i);
        
        // Escludi SOLO domenica (0), sabato (6) è permesso
        if (date.getDay() !== 0) {
            suggested.push({
                date: date.toISOString().split('T')[0],
                formatted: date.toLocaleDateString('it-IT'),
                day_name: date.toLocaleDateString('it-IT', { weekday: 'long' })
            });
        }
    }
    
    return suggested.slice(0, 5); // Prime 5 date disponibili
}


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

// Modifica la funzione reschedule per includere SMS
app.post('/api/reschedule-appointment', async (req, res) => {
    try {
        console.log('📅 Riprogrammazione appuntamento:', req.body);
        const { appointment_id, matricola, new_date, new_time_slot, reason } = req.body;
        
        // Trova l'appuntamento e l'operatore
        const appointmentQuery = `
            SELECT p.*, o.nome, o.cognome, o.telefono as operatore_telefono
            FROM pianificazioni p
            LEFT JOIN operatori o ON p.operatore_id = o.id
            WHERE p.id = $1 OR p.matricola = $2
        `;
        
        const appointmentResult = await pool.query(appointmentQuery, [appointment_id, matricola]);
        
        if (appointmentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const appointment = appointmentResult.rows[0];
        
        // Aggiorna appuntamento
        const updateQuery = `
            UPDATE pianificazioni 
            SET data_appuntamento = $1,
                fascia_oraria = $2,
                stato = 'riprogrammato',
                note_riprogrammazione = $3,
                data_modifica = CURRENT_TIMESTAMP
            WHERE id = $4 OR matricola = $5
            RETURNING *
        `;
        
        await pool.query(`
            ALTER TABLE pianificazioni 
            ADD COLUMN IF NOT EXISTS note_riprogrammazione TEXT,
            ADD COLUMN IF NOT EXISTS data_modifica TIMESTAMP
        `).catch(() => {});
        
        const result = await pool.query(updateQuery, [
            new_date, 
            new_time_slot, 
            reason || 'Riprogrammato su richiesta cliente',
            appointment_id,
            matricola
        ]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        // Invia SMS all'operatore se ha il telefono
        if (appointment.operatore_telefono) {
            const newDateFormatted = new Date(new_date).toLocaleDateString('it-IT');
            const smsMessage = `🔄 APPUNTAMENTO MODIFICATO
Cliente: ${appointment.nome_utente}
Indirizzo: ${appointment.indirizzo}, ${appointment.comune}
Matricola: ${appointment.matricola}
NUOVO APPUNTAMENTO: ${newDateFormatted} ore ${new_time_slot}
Motivo: ${reason || 'Richiesta cliente'}`;

            await sendSMSToOperator(appointment.operatore_telefono, smsMessage);
        }
        
        // Log della modifica
        await pool.query(`
            INSERT INTO call_logs (matricola, action_taken, details, timestamp)
            VALUES ($1, 'riprogrammazione', $2, CURRENT_TIMESTAMP)
        `, [matricola, `Spostato a ${new_date} ${new_time_slot} - SMS inviato`]).catch(() => {});
        
        const newDateFormatted = new Date(new_date).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Ho spostato il suo appuntamento al ${newDateFormatted} nella fascia oraria ${new_time_slot}. Al nostro operatore è stato notificato della modifica. Desidera altro?`
        });
        
    } catch (error) {
        console.error('❌ Errore riprogrammazione:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la riprogrammazione. Riprovi tra poco.'
        });
    }
});

// Nuova funzione per conferma appuntamento con SMS
app.post('/api/confirm-appointment', async (req, res) => {
    try {
        console.log('✅ Conferma appuntamento:', req.body);
        const { appointment_id, matricola } = req.body;
        
        // Trova l'appuntamento e l'operatore
        const appointmentQuery = `
            SELECT p.*, o.nome, o.cognome, o.telefono as operatore_telefono
            FROM pianificazioni p
            LEFT JOIN operatori o ON p.operatore_id = o.id
            WHERE p.id = $1 OR p.matricola = $2
        `;
        
        const appointmentResult = await pool.query(appointmentQuery, [appointment_id, matricola]);
        
        if (appointmentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Appuntamento non trovato'
            });
        }
        
        const appointment = appointmentResult.rows[0];
        
        // Aggiungi campo stato se non esiste
        await pool.query(`
            ALTER TABLE pianificazioni 
            ADD COLUMN IF NOT EXISTS stato VARCHAR(50) DEFAULT 'programmato'
        `).catch(() => {});
        
        const updateQuery = `
            UPDATE pianificazioni 
            SET stato = 'confermato',
                data_conferma = CURRENT_TIMESTAMP
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
        
        // Invia SMS di conferma all'operatore se ha il telefono
        if (appointment.operatore_telefono) {
            const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
            const smsMessage = `✅ APPUNTAMENTO CONFERMATO
Cliente: ${appointment.nome_utente}
Indirizzo: ${appointment.indirizzo}, ${appointment.comune}
Matricola: ${appointment.matricola}
Data: ${dataFormatted} ore ${appointment.fascia_oraria}
Il cliente ha confermato telefonicamente.`;

            await sendSMSToOperator(appointment.operatore_telefono, smsMessage);
        }
        
        // Log della conferma
        await pool.query(`
            INSERT INTO call_logs (matricola, action_taken, details, timestamp)
            VALUES ($1, 'conferma', 'Appuntamento confermato telefonicamente - SMS inviato', CURRENT_TIMESTAMP)
        `, [matricola]).catch(() => {});
        
        const dataFormatted = new Date(appointment.data_appuntamento).toLocaleDateString('it-IT');
        
        res.json({
            success: true,
            message: `Perfetto! Il suo appuntamento per ${dataFormatted} nella fascia oraria ${appointment.fascia_oraria} è stato confermato. Il nostro operatore è stato notificato e si presenterà nell'orario concordato. Ha altre domande?`
        });
        
    } catch (error) {
        console.error('❌ Errore conferma appuntamento:', error);
        res.status(500).json({
            success: false,
            error: 'Errore durante la conferma. Riprovi tra poco.'
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
