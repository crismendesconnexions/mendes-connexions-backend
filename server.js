// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const helmet = require('helmet');
const https = require('https');

const app = express();

// =============================================
// CONFIGURAÇÃO DE SEGURANÇA
// =============================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.disable('x-powered-by');

// =============================================
// CONFIGURAÇÃO CORS ATUALIZADA
// =============================================
const corsOptions = {
  origin: [
    'https://mendesconnexions.com.br',
    'https://www.mendesconnexions.com.br',
    'http://localhost:3000',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pré-flight para todas as rotas

// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware de log para debug
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`, {
    body: req.body,
    headers: req.headers
  });
  next();
});

// =============================================
// HEALTH CHECK
// =============================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)} segundos`,
    firebase: !!admin.apps.length
  });
});

// =============================================
// INICIALIZAÇÃO FIREBASE ADMIN
// =============================================
let serviceAccount;
let db = null;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT não encontrado nas variáveis de ambiente');
  }
} catch (err) {
  console.error('❌ Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err.message);
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`
    });
    console.log('✅ Firebase Admin inicializado com sucesso');
    db = admin.firestore();
  } catch (error) {
    console.error('❌ Erro crítico ao inicializar Firebase Admin:', error);
  }
} else {
  console.error('❌ Firebase Admin não inicializado - serviceAccount indisponível');
}

// =============================================
// CONFIGURAÇÃO SANTANDER
// =============================================
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE || "178622",
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE || "REGISTRO12",
  DICT_KEY: process.env.SANTANDER_DICT_KEY || "09199193000126"
};

// =============================================
// AGENTE HTTPS SANTANDER
// =============================================
function createHttpsAgent() {
  try {
    const certBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;
    
    if (!certBase64 || !keyBase64) {
      console.error('❌ Certificado ou chave privada não encontrados');
      return null;
    }

    const cert = Buffer.from(certBase64, 'base64').toString('utf-8');
    const key = Buffer.from(keyBase64, 'base64').toString('utf-8');

    return new https.Agent({
      cert: cert,
      key: key,
      rejectUnauthorized: true,
      keepAlive: true
    });
  } catch (error) {
    console.error('❌ Erro ao criar agente HTTPS:', error.message);
    return null;
  }
}

// =============================================
// FUNÇÃO ATUALIZADA: BUSCAR CLIENT NUMBER
// =============================================
async function buscarClientNumber(lojistaId) {
  if (!db) {
    console.error('❌ Firestore não inicializado');
    return null;
  }
  
  try {
    console.log('🔍 Buscando clientNumber para lojista:', lojistaId);
    
    // Busca direta pelo documento do lojista
    const lojistaDoc = await db.collection('lojistas').doc(lojistaId).get();
    
    if (lojistaDoc.exists) {
      const lojistaData = lojistaDoc.data();
      const clientNumber = lojistaData.clientNumber || lojistaData.idNumber;
      
      console.log('📋 Dados do lojista encontrado:', {
        exists: lojistaDoc.exists,
        clientNumber: clientNumber,
        nome: lojistaData.nomeFantasia || lojistaData.nome,
        cnpj: lojistaData.cnpj
      });
      
      if (clientNumber) {
        console.log('✅ ClientNumber encontrado:', clientNumber);
        return clientNumber.toString();
      } else {
        console.log('❌ ClientNumber não encontrado nos dados do lojista');
        console.log('Campos disponíveis:', Object.keys(lojistaData));
        return null;
      }
    } else {
      console.log('❌ Lojista não encontrado no Firestore');
      return null;
    }
  } catch (error) {
    console.error('💥 Erro ao buscar clientNumber no Firebase:', error);
    return null;
  }
}

// =============================================
// FUNÇÕES AUXILIARES SANTANDER
// =============================================

// Obter token Santander
async function obterTokenSantander() {
  console.log("\n=== [1] Solicitando TOKEN Santander ===");
  
  const formData = new URLSearchParams({
    client_id: SANTANDER_CONFIG.CLIENT_ID,
    client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'collection_bill_management'
  });

  try {
    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        httpsAgent: httpsAgent,
        timeout: 30000
      }
    );
    
    console.log("✅ Token recebido com sucesso");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Erro ao obter token Santander:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    throw err;
  }
}

// Criar Workspace
async function criarWorkspace(accessToken) {
  console.log("\n=== [2] Criando WORKSPACE ===");
  
    const payload = {
      type: "BILLING",
      description: "Workspace de Cobranca Mendes Connexions", // sem acentos
      covenants: [{ code: SANTANDER_CONFIG.COVENANT_CODE.toString() }]
    };
  
  console.log("➡️ Payload Workspace:", JSON.stringify(payload, null, 2));

  try {
    const httpsAgent = createHttpsAgent();
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Accept': 'application/json'
        },
        httpsAgent: httpsAgent,
        timeout: 30000
      }
    );
    
    console.log("✅ Workspace criada:", response.data.id);
    return response.data.id;
  } catch (err) {
    console.error("❌ Erro ao criar workspace:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    throw err;
  }
}

// Calcular 5º dia útil do próximo mês
function calcularQuintoDiaUtilProximoMes() {
  const hoje = new Date();
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth() + 1;
  
  // Ajustar para próximo mês
  if (mes === 12) {
    mes = 1;
    ano += 1;
  } else {
    mes += 1;
  }
  
  const data = new Date(ano, mes - 1, 1); // primeiro dia do próximo mês
  let diasUteis = 0;

  while (diasUteis < 5) {
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) { // Não é domingo (0) nem sábado (6)
      diasUteis++;
      if (diasUteis === 5) break;
    }
    data.setDate(data.getDate() + 1);
  }

  return data.toISOString().split('T')[0];
}

// Função para gerar nsuDate no formato YYYY-MM-DD
function gerarNsuDate() {
  return new Date().toISOString().split('T')[0];
}

// Função para gerar issueDate = hoje + 1 dia
function gerarIssueDate() {
  const hoje = new Date();
  hoje.setDate(hoje.getDate() + 1);
  return hoje.toISOString().split('T')[0];
}

// Função para gerar discount limitDate = hoje + 5 dias
function gerarDiscountLimitDate() {
  const hoje = new Date();
  hoje.setDate(hoje.getDate() + 5);
  return hoje.toISOString().split('T')[0];
}

// =============================================
// ROTA PRINCIPAL ATUALIZADA: REGISTRAR BOLETO
// =============================================
app.post('/api/santander/boletos', async (req, res) => {
  console.log("📥 Recebendo requisição para gerar boleto...");
  
  const { dadosBoleto, lojistaId } = req.body;
  
  if (!dadosBoleto || !lojistaId) {
    console.log('❌ Dados incompletos:', {
      temDadosBoleto: !!dadosBoleto,
      temLojistaId: !!lojistaId
    });
    return res.status(400).json({
      error: 'Dados do boleto ou ID do lojista não fornecidos',
      details: 'É necessário enviar dadosBoleto e lojistaId no corpo da requisição'
    });
  }

  try {
    console.log("👤 Lojista ID recebido:", lojistaId);
    
    // Busca clientNumber baseado no lojistaId (CORRIGIDO)
    const clientNumber = await buscarClientNumber(lojistaId);
    
    if (!clientNumber) {
      return res.status(400).json({
        error: 'ClientNumber do lojista não encontrado no Firebase',
        details: 'Verifique se o lojista está cadastrado corretamente com clientNumber ou idNumber'
      });
    }

    console.log("✅ ClientNumber encontrado, obtendo token...");
    const accessToken = await obterTokenSantander();
    const workspaceId = await criarWorkspace(accessToken);

    console.log("\n=== [3] Registrando BOLETO ===");
    console.log("💰 ClientNumber utilizado:", clientNumber);

    const dueDate = calcularQuintoDiaUtilProximoMes();
    const discountLimitDate = gerarDiscountLimitDate();

    const payload = {
      environment: "PRODUCAO",
      nsuCode: `${clientNumber}${Date.now()}`,
      nsuDate: gerarNsuDate(),
      covenantCode: parseInt(SANTANDER_CONFIG.COVENANT_CODE),
      bankNumber: "0036",
      clientNumber: clientNumber,
      dueDate: dueDate,
      issueDate: gerarIssueDate(),
      participantCode: SANTANDER_CONFIG.PARTICIPANT_CODE,
      nominalValue: parseFloat(dadosBoleto.valorCompra).toFixed(2),
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: [
        "Pagamento até o 5o dia útil de cada mes",
        "Protestar após 30 dias de vencimento"
      ],
      payer: {
        name: dadosBoleto.pagadorNome,
        documentType: "CNPJ",
        documentNumber: dadosBoleto.pagadorDocumento,
        address: dadosBoleto.pagadorEndereco,
        neighborhood: dadosBoleto.bairro,
        city: dadosBoleto.pagadorCidade,
        state: dadosBoleto.pagadorEstado,
        zipCode: dadosBoleto.pagadorCEP.replace(/\D/g, '') // Remove caracteres não numéricos
      },
      key: {
        type: "CNPJ",
        dictKey: SANTANDER_CONFIG.DICT_KEY
      },
      discount: {
        type: "VALOR_DATA_FIXA",
        discountOne: {
          value: "0.50",
          limitDate: discountLimitDate
        }
      },
      interestPercentage: "05.00"
    };

    console.log("📦 Payload Boleto:", JSON.stringify(payload, null, 2));

    const httpsAgent = createHttpsAgent();
    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        httpsAgent: httpsAgent,
        timeout: 30000
      }
    );

    console.log("✅ Boleto registrado com sucesso!");
    
    res.json({
      success: true,
      message: 'Boleto registrado com sucesso',
      boletoId: boletoResponse.data.nsuCode,
      ...boletoResponse.data
    });

  } catch (error) {
    console.error("❌ Erro no fluxo Santander:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Falha no processo Santander',
      details: error.response?.data || error.message,
      step: 'registro_boleto'
    });
  }
});

// =============================================
// NOVA ROTA: BUSCAR DADOS LOJISTA
// =============================================
app.get('/api/lojista/:lojistaId', async (req, res) => {
  const { lojistaId } = req.params;
  
  if (!db) {
    return res.status(500).json({ error: 'Firestore não disponível' });
  }

  try {
    const lojistaDoc = await db.collection('lojistas').doc(lojistaId).get();
    
    if (!lojistaDoc.exists) {
      return res.status(404).json({ error: 'Lojista não encontrado' });
    }

    const lojistaData = lojistaDoc.data();
    res.json({
      id: lojistaId,
      ...lojistaData
    });
  } catch (error) {
    console.error('Erro ao buscar lojista:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// =============================================
// ROTA DE TESTE SANTANDER
// =============================================
app.get('/api/santander/test', async (req, res) => {
  try {
    console.log('🧪 Testando conexão com Santander...');
    const token = await obterTokenSantander();
    
    res.json({
      success: true,
      message: 'Conexão com Santander OK',
      tokenReceived: !!token
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro na conexão com Santander',
      error: error.message
    });
  }
});

// =============================================
// HANDLERS GLOBAIS DE ERRO
// =============================================
app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    path: req.path,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Erro global não tratado:', err.stack);
  res.status(500).json({
    error: 'Algo deu errado no servidor!',
    message: err.message
  });
});

// =============================================
// INICIALIZAÇÃO DO SERVIDOR
// =============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Servidor rodando na porta ${PORT}
📍 Ambiente: ${process.env.NODE_ENV || 'development'}
📊 Health check: http://localhost:${PORT}/health
🔧 Firebase: ${admin.apps.length > 0 ? '✅ Inicializado' : '❌ Não inicializado'}
  `);
});
