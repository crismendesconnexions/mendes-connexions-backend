// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// -------------------------
// Configuração de CORS
// -------------------------
const allowedOrigins = [
  'https://mendesconnexions.com.br',
  'http://localhost:3000'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Não permitido pelo CORS'));
    }
  }
}));
app.use(express.json());

// -------------------------
// Variáveis de ambiente
// -------------------------
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.Client_Id || 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI',
  CLIENT_SECRET: process.env.Client_Secret || 'lrHiIZpKnGFGNcJF',
  COVENANT_CODE: process.env.CovenantCode || '178622',
  PARTICIPANT_CODE: process.env.ParticipantCode || 'REGISTRO12',
  DICT_KEY: process.env.DictKey || '09199193000126'
};

// -------------------------
// Função auxiliar para obter token
// -------------------------
async function getSantanderToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  const basicAuth = Buffer.from(`${SANTANDER_CONFIG.CLIENT_ID}:${SANTANDER_CONFIG.CLIENT_SECRET}`).toString('base64');

  const response = await axios.post(
    'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
        'User-Agent': 'PostmanRuntime/7.32.3'
      },
      timeout: 15000
    }
  );

  return response.data;
}

// -------------------------
// Rota: obter token
// -------------------------
app.post('/api/santander/token', async (req, res) => {
  try {
    console.log('Solicitando token do Santander...');
    const tokenData = await getSantanderToken();
    res.json(tokenData);
  } catch (error) {
    console.error('Erro ao obter token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao obter token', details: error.response?.data || error.message });
  }
});

// -------------------------
// Rota: criar workspace
// -------------------------
app.post('/api/santander/workspace', async (req, res) => {
  try {
    const { accessToken } = req.body;
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        type: 'BILLING',
        description: 'Workspace de Cobrança',
        covenants: [{ code: parseInt(SANTANDER_CONFIG.COVENANT_CODE) }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 15000
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao criar workspace:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao criar workspace', details: error.response?.data || error.message });
  }
});

// -------------------------
// Rota: listar workspaces
// -------------------------
app.get('/api/santander/workspaces', async (req, res) => {
  try {
    const { accessToken } = req.query;
    const response = await axios.get(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/',
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 15000
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao listar workspaces:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao listar workspaces', details: error.response?.data || error.message });
  }
});

// -------------------------
// Rota: registrar boleto
// -------------------------
app.post('/api/santander/boletos', async (req, res) => {
  try {
    const { accessToken, workspaceId, dadosBoleto } = req.body;
    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      dadosBoleto,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 30000
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao registrar boleto', details: error.response?.data || error.message });
  }
});

// -------------------------
// Rota: gerar PDF do boleto
// -------------------------
app.post('/api/santander/boletos/pdf', async (req, res) => {
  try {
    const { accessToken, digitableLine, payerDocumentNumber } = req.body;
    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      { payerDocumentNumber: payerDocumentNumber || "12345678900" },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 30000
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao gerar PDF', details: error.response?.data || error.message });
  }
});

// -------------------------
// Health check
// -------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Servidor funcionando' });
});

// -------------------------
// Start server
// -------------------------
app.listen(port, () => {
  console.log(`Servidor Mendes Connexions rodando na porta ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});

module.exports = app;
