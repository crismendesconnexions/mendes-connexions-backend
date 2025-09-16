const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Credenciais Santander (as mesmas do frontend)
const SANTANDER_CONFIG = {
  CLIENT_ID: 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI',
  CLIENT_SECRET: 'lrHiIZpKnGFGNcJF',
  COVENANT_CODE: '178622',
  PARTICIPANT_CODE: 'REGISTRO12',
  DICT_KEY: '09199193000126'
};

// Rota para obter token do Santander
app.post('/api/santander/token', async (req, res) => {
  try {
    console.log('Solicitando token do Santander...');
    
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
        },
        timeout: 15000
      }
    );

    console.log('Token obtido com sucesso');
    res.json(response.data);
    
  } catch (error) {
    console.error('Erro ao obter token do Santander:', error.message);
    console.error('Detalhes:', error.response?.data || 'Sem detalhes adicionais');
    
    res.status(500).json({
      error: 'Erro ao obter token do Santander',
      details: error.message
    });
  }
});

// Rota para criar workspace no Santander
app.post('/api/santander/workspace', async (req, res) => {
  try {
    const { accessToken } = req.body;
    console.log('Criando workspace no Santander...');

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

    console.log('Workspace criado com sucesso:', response.data.id);
    res.json(response.data);
    
  } catch (error) {
    console.error('Erro ao criar workspace:', error.message);
    console.error('Detalhes:', error.response?.data || 'Sem detalhes adicionais');
    
    res.status(500).json({
      error: 'Erro ao criar workspace no Santander',
      details: error.message
    });
  }
});

// Rota para listar workspaces existentes
app.get('/api/santander/workspaces', async (req, res) => {
  try {
    const { accessToken } = req.body;
    console.log('Listando workspaces...');

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
    console.error('Erro ao listar workspaces:', error.message);
    
    res.status(500).json({
      error: 'Erro ao listar workspaces',
      details: error.message
    });
  }
});

// Rota para registrar boleto no Santander
app.post('/api/santander/boletos', async (req, res) => {
  try {
    const { accessToken, workspaceId, dadosBoleto } = req.body;
    console.log('Registrando boleto no Santander...');

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

    console.log('Boleto registrado com sucesso');
    res.json(response.data);
    
  } catch (error) {
    console.error('Erro ao registrar boleto:', error.message);
    console.error('Detalhes do erro:', error.response?.data || 'Sem detalhes');
    
    res.status(500).json({
      error: 'Erro ao registrar boleto no Santander',
      details: error.message,
      response: error.response?.data
    });
  }
});

// Rota para gerar PDF do boleto
app.post('/api/santander/boletos/pdf', async (req, res) => {
  try {
    const { accessToken, digitableLine, payerDocumentNumber } = req.body;
    console.log('Gerando PDF do boleto...');

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
        },
        timeout: 30000
      }
    );

    console.log('PDF gerado com sucesso');
    res.json(response.data);
    
  } catch (error) {
    console.error('Erro ao gerar PDF:', error.message);
    
    res.status(500).json({
      error: 'Erro ao gerar PDF do boleto',
      details: error.message
    });
  }
});

// Rota de health check para o Render
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Servidor funcionando' });
});

// Rota padrão
app.get('/', (req, res) => {
  res.json({
    message: 'Backend Mendes Connexions',
    version: '1.0.0',
    endpoints: {
      token: 'POST /api/santander/token',
      workspace: 'POST /api/santander/workspace',
      boletos: 'POST /api/santander/boletos',
      pdf: 'POST /api/santander/boletos/pdf'
    }
  });
});

// Middleware para rotas não encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor Mendes Connexions rodando na porta ${port}`);
  console.log(`Health check disponível em: http://localhost:${port}/health`);
});

module.exports = app;
