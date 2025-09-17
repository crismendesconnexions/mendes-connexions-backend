// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Inicializar Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Credenciais Santander (agora seguras no backend)
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID || 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI',
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET || 'lrHiIZpKnGFGNcJF',
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE || '178622',
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE || 'REGISTRO12',
  DICT_KEY: process.env.SANTANDER_DICT_KEY || '09199193000126'
};

// Middleware de autenticação
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Token de acesso não fornecido' });
    }
    
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
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
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
    
    // Primeiro obter token
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    
    // Aqui implementar a lógica de workspace (obter ou criar)
    // E depois registrar o boleto
    
    // Esta é uma implementação simplificada
    const workspaceId = await obterWorkspaceId(accessToken);
    
    const nsuCode = gerarNumeroUnico(dadosBoleto.clientNumber);
    const bankNumber = await gerarBankNumberSequencial();
    
    // Construir payload do boleto
    const payload = {
      // ... (mesmo payload que estava no frontend)
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
    
    // Obter token
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    
    const pdfResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      {
        payerDocumentNumber: payerDocumentNumber
      },
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

// Funções auxiliares (manter as mesmas do frontend, mas agora no backend)
function gerarNumeroUnico(clientNumber) {
  // Implementação igual à do frontend
}

async function gerarBankNumberSequencial() {
  // Implementação igual à do frontend, mas usando banco de dados para persistência
}

async function obterWorkspaceId(accessToken) {
  // Implementação para obter ou criar workspace
}

// 🔹 Health check (novo)
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Backend online"
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
