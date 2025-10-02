// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const helmet = require('helmet');
const https = require('https');

const app = express();

// Segurança
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.disable('x-powered-by');

// CORS
app.use(cors({
  origin: [
    'https://mendesconnexions.com.br',
    'https://www.mendesconnexions.com.br'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)} segundos`
  });
});

// Firebase
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err);
  }
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    console.log('Firebase Admin inicializado');
  } catch (error) {
    console.error('Erro ao inicializar Firebase Admin:', error);
  }
}

const db = admin.firestore ? admin.firestore() : null;

// Config Santander
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE || "178622"
};

// Agente HTTPS Santander
function createHttpsAgent() {
  try {
    const certBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;
    if (!certBase64 || !keyBase64) return null;

    return new https.Agent({
      cert: Buffer.from(certBase64, 'base64').toString('utf-8'),
      key: Buffer.from(keyBase64, 'base64').toString('utf-8'),
      rejectUnauthorized: true
    });
  } catch (error) {
    console.error('Erro criar agente HTTPS:', error);
    return null;
  }
}

// Obter token Santander
async function obterTokenSantander() {
  console.log("\n=== [1] Solicitando TOKEN Santander ===");
  const formData = new URLSearchParams({
    client_id: SANTANDER_CONFIG.CLIENT_ID,
    client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: createHttpsAgent() }
    );
    console.log("✅ Token recebido");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Erro ao obter token Santander:", err.response?.data || err.message);
    throw err;
  }
}

// Criar Workspace
async function criarWorkspace(accessToken) {
  console.log("\n=== [2] Criando WORKSPACE ===");
  const payload = {
    type: "BILLING",
    description: "Workspace de Cobrança",
    covenants: [{ code: parseInt(SANTANDER_CONFIG.COVENANT_CODE) }]
  };
  console.log("➡️ Payload Workspace:", payload);

  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        },
        httpsAgent: createHttpsAgent()
      }
    );
    console.log("✅ Workspace criada:", response.data.id);
    return response.data.id;
  } catch (err) {
    console.error("❌ Erro ao criar workspace:", err.response?.data || err.message);
    throw err;
  }
}

// Calcular 5º dia útil do próximo mês
function calcularQuintoDiaUtilProximoMes() {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1; // próximo mês
  const data = new Date(ano, mes, 1); // primeiro dia do próximo mês
  let diasUteis = 0;

  while (true) {
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) {
      diasUteis++;
      if (diasUteis === 5) break;
    }
    data.setDate(data.getDate() + 1);
  }

  return data.toISOString().split('T')[0];
}

// Registrar boleto
app.post('/api/santander/boletos', async (req, res) => {
  const { dadosBoleto } = req.body;
  if (!dadosBoleto) return res.status(400).json({ error: 'Dados do boleto não fornecidos' });

  try {
    const accessToken = await obterTokenSantander();
    const workspaceId = await criarWorkspace(accessToken);

    console.log("\n=== [3] Registrando BOLETO ===");

    const hoje = new Date().toISOString();
    const dueDate = calcularQuintoDiaUtilProximoMes();

    const payload = {
      nsuCode: `${dadosBoleto.clientNumber}-${Date.now()}`, // NSU único
      nsuDate: hoje, // Data/hora da criação do NSU
      paymentType: "REGISTRO",
      issueDate: hoje.split('T')[0],
      dueDate: dueDate,
      covenantCode: parseInt(SANTANDER_CONFIG.COVENANT_CODE),
      environment: "PRODUCAO",
      nominalValue: dadosBoleto.valorCompra,
      documentKind: "DUPLICATA_MERCANTIL",

      // Pagador
      payer: {
        name: dadosBoleto.pagadorNome,
        document: dadosBoleto.pagadorDocumento,
        address: dadosBoleto.pagadorEndereco,
        city: dadosBoleto.pagadorCidade,
        state: dadosBoleto.pagadorEstado,
        zipCode: dadosBoleto.pagadorCEP
      }
    };

    console.log("➡️ Payload Boleto:", payload);

    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        httpsAgent: createHttpsAgent()
      }
    );

    console.log("✅ Boleto registrado:", boletoResponse.data);
    res.json(boletoResponse.data);

  } catch (error) {
    console.error("❌ Erro no fluxo Santander:", error.response?.data || error.message);
    res.status(500).json({
      error: 'Falha no processo Santander',
      details: error.response?.data || error.message
    });
  }
});

// Auxiliar sequencial (Firebase)
async function gerarBankNumberSequencial() {
  if (!db) return Math.floor(Math.random() * 1000000);
  try {
    const counterRef = db.collection('counters').doc('bankNumber');
    return await db.runTransaction(async (t) => {
      const doc = await t.get(counterRef);
      const newSeq = doc.exists ? doc.data().sequence + 1 : 1;
      t.set(counterRef, { sequence: newSeq }, { merge: true });
      return newSeq;
    });
  } catch {
    return Math.floor(Math.random() * 1000000);
  }
}

// Handlers globais
app.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));
app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  res.status(500).json({ error: 'Algo deu errado no servidor!' });
});

// Inicialização
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});
