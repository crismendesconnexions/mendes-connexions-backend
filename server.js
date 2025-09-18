// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Inicializar Firebase Admin via variável de ambiente
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Credenciais Santander via variáveis de ambiente
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE,
  DICT_KEY: process.env.SANTANDER_DICT_KEY
};

// Middleware de autenticação Firebase
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token de acesso não fornecido' });

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Rota para obter token Santander
app.post('/api/santander/token', authenticate, async (req, res) => {
  try {
    const formData = new URLSearchParams();
    formData.append('client_id', SANTANDER_CONFIG.CLIENT_ID);
    formData.append('client_secret', SANTANDER_CONFIG.CLIENT_SECRET);
    formData.append('grant_type', 'client_credentials');

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao obter token Santander:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao obter token' });
  }
});

// Rota para registrar boleto
app.post('/api/santander/boletos', authenticate, async (req, res) => {
  try {
    const { dadosBoleto } = req.body;

    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenResponse.data.access_token;
    const workspaceId = await obterWorkspaceId(accessToken);
    const nsuCode = gerarNumeroUnico(dadosBoleto.clientNumber);
    const bankNumber = await gerarBankNumberSequencial();

    // Payload do boleto conforme Santander
      const payload = {
        dueDate: new Date(dadosBoleto.dueDate).toISOString().split('T')[0], // garante YYYY-MM-DD
        amount: Number(dadosBoleto.amount),
        clientNumber: String(dadosBoleto.clientNumber),
        nsu: nsuCode,
        bankNumber: Number(bankNumber),
        payer: {
          name: String(dadosBoleto.payer.name),
          documentNumber: String(dadosBoleto.payer.document).replace(/\D/g, '') // só números
        },
        covenant: String(SANTANDER_CONFIG.COVENANT_CODE),
        participantCode: String(SANTANDER_CONFIG.PARTICIPANT_CODE),
        dictKey: String(SANTANDER_CONFIG.DICT_KEY)
      };


    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    res.json(boletoResponse.data);
  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao registrar boleto' });
  }
});

// Rota para gerar PDF do boleto
app.post('/api/santander/boletos/pdf', authenticate, async (req, res) => {
  try {
    const { digitableLine, payerDocumentNumber } = req.body;

    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenResponse.data.access_token;

    const pdfResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      { payerDocumentNumber },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    res.json(pdfResponse.data);
  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao gerar PDF' });
  }
});

// Funções auxiliares
function gerarNumeroUnico(clientNumber) {
  const timestamp = Date.now();
  return `${clientNumber}-${timestamp}`;
}

async function gerarBankNumberSequencial() {
  const docRef = db.collection('sequenciais').doc('bankNumber');
  const doc = await docRef.get();
  let number = doc.exists ? doc.data().last + 1 : 100000;
  await docRef.set({ last: number });
  return number;
}

async function obterWorkspaceId(accessToken) {
  // Aqui você pode buscar workspace existente ou criar um novo
  // Para simplificação, retornamos um workspace fixo
  return 'workspace-principal';
}

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Backend online" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
