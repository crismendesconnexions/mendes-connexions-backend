const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Credenciais Santander (em produção, use variáveis de ambiente)
const SANTANDER_CONFIG = {
  CLIENT_ID: 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI',
  CLIENT_SECRET: 'lrHiIZpKnGFGNcJF',
  COVENANT_CODE: '178622',
  PARTICIPANT_CODE: 'REGISTRO12',
  DICT_KEY: '09199193000126'
};

// Rota para obter token
app.post('/api/santander/token', async (req, res) => {
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
    console.error('Erro ao obter token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao obter token do Santander' });
  }
});

// Rota para criar workspace
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
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao criar workspace:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao criar workspace no Santander' });
  }
});

// Rota para registrar boleto
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
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao registrar boleto no Santander' });
  }
});

// Rota para gerar PDF do boleto
app.post('/api/santander/boletos/pdf', async (req, res) => {
  try {
    const { accessToken, digitableLine, payerDocumentNumber } = req.body;

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      {
        payerDocumentNumber: payerDocumentNumber || "12345678900"
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao gerar PDF do boleto' });
  }
});

app.listen(port, () => {
  console.log(`Servidor intermediário rodando na porta ${port}`);
});
