const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();
const port = process.env.PORT || 3000;

// Middleware de segurança
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: ['https://seusite.com', 'http://localhost:3000'], // Substitua pelo seu domínio
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // limite de 100 requests por windowMs
});
app.use('/api/', limiter);

// Inicializar Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || require('./serviceAccountKey.json'));
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
} catch (error) {
  console.error('Erro ao inicializar Firebase Admin:', error);
  process.exit(1);
}

const db = admin.firestore();

// Credenciais Santander (usando variáveis de ambiente)
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID || 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI',
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET || 'lrHiIZpKnGFGNcJF',
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE || '178622',
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE || 'REGISTRO12',
  DICT_KEY: process.env.SANTANDER_DICT_KEY || '09199193000126'
};

// Cache em memória (em produção considere usar Redis)
let tokenCache = {
  accessToken: null,
  expiration: null
};

let workspaceCache = {
  workspaceId: null,
  lastUpdated: null
};

// Logger simples
const logger = {
  info: (message, data = {}) => console.log(JSON.stringify({ level: 'INFO', message, ...data })),
  error: (message, error = {}) => console.error(JSON.stringify({ level: 'ERROR', message, error: error.message || error })),
  warn: (message, data = {}) => console.warn(JSON.stringify({ level: 'WARN', message, ...data }))
};

// Função para obter token Santander
async function obterTokenSantander() {
  try {
    if (tokenCache.accessToken && tokenCache.expiration > Date.now()) {
      logger.info('Usando token cacheado');
      return tokenCache.accessToken;
    }

    logger.info('Solicitando novo token Santander');

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
        timeout: 10000
      }
    );

    tokenCache = {
      accessToken: response.data.access_token,
      expiration: Date.now() + (response.data.expires_in * 1000) - 60000
    };

    logger.info('Token Santander obtido com sucesso');
    return tokenCache.accessToken;
  } catch (error) {
    logger.error('Erro ao obter token Santander', error);
    throw new Error('Falha na autenticação com Santander');
  }
}

// Função para obter workspace
async function obterWorkspaceId() {
  try {
    if (workspaceCache.workspaceId && workspaceCache.lastUpdated &&
        (Date.now() - workspaceCache.lastUpdated) < 3600000) { // 1 hora de cache
      logger.info('Usando workspace cacheado');
      return workspaceCache.workspaceId;
    }

    const token = await obterTokenSantander();
    
    // Primeiro tenta listar workspaces existentes
    try {
      const response = await axios.get(
        'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/',
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
            'Authorization': `Bearer ${token}`
          },
          timeout: 10000
        }
      );

      if (response.data && response.data.length > 0) {
        for (const workspace of response.data) {
          if (workspace.covenants && workspace.covenants.some(c => c.code == SANTANDER_CONFIG.COVENANT_CODE)) {
            workspaceCache = {
              workspaceId: workspace.id,
              lastUpdated: Date.now()
            };
            logger.info('Workspace existente encontrado', { workspaceId: workspace.id });
            return workspace.id;
          }
        }
      }
    } catch (error) {
      logger.warn('Erro ao listar workspaces, tentando criar novo', error);
    }

    // Se não encontrou, cria novo workspace
    const createResponse = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        type: 'BILLING',
        description: 'Workspace de Cobrança Mendes Connexions',
        covenants: [{ code: parseInt(SANTANDER_CONFIG.COVENANT_CODE) }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${token}`
        },
        timeout: 15000
      }
    );

    workspaceCache = {
      workspaceId: createResponse.data.id,
      lastUpdated: Date.now()
    };

    logger.info('Novo workspace criado', { workspaceId: createResponse.data.id });
    return createResponse.data.id;

  } catch (error) {
    logger.error('Erro ao obter workspace', error);
    throw new Error('Falha ao obter workspace Santander');
  }
}

// Middleware de autenticação
async function authenticateLojista(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticação necessário' });
    }

    const token = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    req.lojistaId = decodedToken.uid;
    next();
  } catch (error) {
    logger.error('Falha na autenticação', error);
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Rota para status da integração
app.get('/api/integration-status', authenticateLojista, async (req, res) => {
  try {
    const token = await obterTokenSantander();
    const workspaceId = await obterWorkspaceId();
    
    res.json({
      status: 'connected',
      message: 'Conectado ao Santander com sucesso',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Erro na conexão com Santander',
      error: error.message
    });
  }
});

// Rota para registrar boleto
app.post('/api/registrar-boleto', authenticateLojista, async (req, res) => {
  try {
    const { profissionalId, vendedorId, dataReferencia, valorCompra, observacao } = req.body;

    logger.info('Registrando novo boleto', {
      profissionalId,
      vendedorId,
      valorCompra,
      lojistaId: req.lojistaId
    });

    // Buscar dados do lojista
    const lojistaDoc = await db.collection('lojistas').doc(req.lojistaId).get();
    if (!lojistaDoc.exists) {
      return res.status(404).json({ error: 'Lojista não encontrado' });
    }

    const lojistaData = lojistaDoc.data();

    // Validar dados
    if (!profissionalId || !vendedorId || !valorCompra || valorCompra <= 0) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    const token = await obterTokenSantander();
    const workspaceId = await obterWorkspaceId();

    // Gerar dados do boleto
    const nsuCode = gerarNumeroUnico(lojistaData.idNumber || "00001");
    const bankNumber = await gerarBankNumberSequencial();
    
    const hoje = new Date();
    let vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 5);
    
    if (hoje.getDate() > 5) {
      vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 5);
    }
    
    const dueDate = vencimento.toISOString().split('T')[0];
    const valorBoleto = (valorCompra * 0.02).toFixed(2);
    
    let zipCodeFormatado = (lojistaData.cep || "00000000").replace(/\D/g, '');
    if (zipCodeFormatado.length === 8) {
      zipCodeFormatado = zipCodeFormatado.substring(0, 5) + '-' + zipCodeFormatado.substring(5);
    }
    
    const nomeSanitizado = (lojistaData.nomeFantasia || "Loja Mendes Connexions")
      .replace(/[^a-zA-Z00-9áàâãéèêíïóôõöúçñÁÀÂãÉÈÊÍÏÓÔÕÖÚÇÑ&\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 40);
    
    const payload = {
      environment: 'PRODUCAO',
      nsuCode: nsuCode,
      nsuDate: hoje.toISOString().split('T')[0],
      covenantCode: parseInt(SANTANDER_CONFIG.COVENANT_CODE),
      bankNumber: bankNumber,
      clientNumber: (lojistaData.idNumber || "00001").toString().padStart(5, '0'),
      dueDate: dueDate,
      issueDate: hoje.toISOString().split('T')[0],
      participantCode: SANTANDER_CONFIG.PARTICIPANT_CODE,
      nominalValue: valorBoleto,
      payer: {
        name: nomeSanitizado,
        documentType: "CNPJ",
        documentNumber: (lojistaData.cnpj || "12345678901234").replace(/\D/g, ''),
        address: lojistaData.endereco || "Endereço não informado",
        neighborhood: lojistaData.bairro || "Bairro não informado",
        city: lojistaData.cidade || "Cidade não informada",
        state: lojistaData.estado || "SP",
        zipCode: zipCodeFormatado
      },
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: [
        "Protestar após 30 dias.",
        "Após o vencimento 1% a.m."
      ],
      key: {
        type: "CNPJ",
        dictKey: SANTANDER_CONFIG.DICT_KEY
      },
      discount: {
        type: "VALOR_DATA_FIXA",
        discountOne: {
          value: "0.10",
          limitDate: dueDate
        }
      },
      interestPercentage: "1.00"
    };

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${token}`
        },
        timeout: 30000
      }
    );

    const boletoData = {
      ...response.data,
      nsuCode: nsuCode,
      bankNumber: bankNumber,
      dueDate: dueDate,
      valorBoleto: parseFloat(valorBoleto)
    };

    logger.info('Boleto registrado com sucesso', { nsuCode, valorBoleto });

    res.json(boletoData);

  } catch (error) {
    logger.error('Erro ao registrar boleto', error);
    res.status(500).json({
      error: 'Erro ao registrar boleto',
      details: error.response?.data || error.message
    });
  }
});

// Rota para gerar PDF do boleto
app.post('/api/gerar-pdf', authenticateLojista, async (req, res) => {
  try {
    const { digitableLine } = req.body;

    const lojistaDoc = await db.collection('lojistas').doc(req.lojistaId).get();
    if (!lojistaDoc.exists) {
      return res.status(404).json({ error: 'Lojista não encontrado' });
    }

    const lojistaData = lojistaDoc.data();
    const token = await obterTokenSantander();

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      {
        payerDocumentNumber: (lojistaData.cnpj || "12345678901234").replace(/\D/g, '')
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${token}`
        },
        timeout: 15000
      }
    );

    res.json({ pdfUrl: response.data.link });

  } catch (error) {
    logger.error('Erro ao gerar PDF', error);
    res.status(500).json({
      error: 'Erro ao gerar PDF',
      details: error.response?.data || error.message
    });
  }
});

// Funções auxiliares
function gerarNumeroUnico(clientNumber) {
  const now = new Date();
  const timestamp = now.getTime().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${timestamp}${random}${String(clientNumber).padStart(5, '0')}`;
}

async function gerarBankNumberSequencial() {
  try {
    // Usar Firebase para armazenar o último número de forma atômica
    const counterRef = db.collection('counters').doc('bankNumber');
    
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      let currentNumber = 1;
      
      if (doc.exists) {
        currentNumber = doc.data().lastNumber + 1;
      }
      
      transaction.set(counterRef, { lastNumber: currentNumber, updatedAt: new Date() });
      return currentNumber;
    });

    return result.toString().padStart(6, '0');
  } catch (error) {
    logger.error('Erro ao gerar bankNumber sequencial', error);
    // Fallback: usar timestamp
    return Date.now().toString().slice(-6).padStart(6, '0');
  }
}

// Error handler
app.use((error, req, res, next) => {
  logger.error('Erro não tratado', error);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Recebido SIGTERM, encerrando servidor graciosamente');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Recebido SIGINT, encerrando servidor graciosamente');
  process.exit(0);
});

// Iniciar servidor
app.listen(port, '0.0.0.0', () => {
  logger.info(`Servidor rodando na porta ${port}`);
  logger.info('Ambiente:', { nodeEnv: process.env.NODE_ENV, port });
});
