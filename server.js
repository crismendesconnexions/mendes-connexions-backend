const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const helmet = require('helmet');
const https = require('https');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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
// CONFIGURAÇÃO CORS DINÂMICA (CORREÇÃO PARA FLUTTER WEB)
// =============================================
const allowedOrigins = [
  'https://mendesconnexions.com.br',
  'https://www.mendesconnexions.com.br',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:56179',  // Porta do Flutter Web
  'http://localhost:5000',
  'http://127.0.0.1:56179',
  'http://127.0.0.1:5000',
  'https://mendes-connexions.web.app',
  'https://mendes-connexions.firebaseapp.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Permite requisições sem origin (como apps mobile ou curl)
    if (!origin) {
      console.log('✅ Requisição sem origin (mobile/curl) - permitida');
      return callback(null, true);
    }
    
    const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    const isAllowedDomain = allowedOrigins.indexOf(origin) !== -1;

    if (isLocalhost || isAllowedDomain) {
      console.log('✅ CORS permitido para:', origin);
      callback(null, true);
    } else {
      console.log('🚫 Bloqueado pelo CORS:', origin);
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Application-Key'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Middleware de log para debug
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📥 ${req.method} ${req.path} | Origem: ${req.headers.origin || 'N/A'} | Status: ${res.statusCode} | ${duration}ms`);
  });
  next();
});

// =============================================
// ROTA DE TESTE / HEALTH CHECK
// =============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'Servidor funcionando!',
    cors: req.headers.origin ? 'permitido' : 'qualquer'
  });
});

app.get('/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Backend está funcionando!',
    timestamp: new Date().toISOString()
  });
});

// =============================================
// INICIALIZAÇÃO FIREBASE ADMIN
// =============================================
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`
      });
      console.log('✅ Firebase Admin inicializado');
    }
    db = admin.firestore();
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT ausente.');
  }
} catch (err) {
  console.error('❌ Erro Crítico Firebase:', err.message);
}

// =============================================
// FUNÇÕES AUXILIARES
// =============================================
function calcularCincoDiasUteis() {
  const data = new Date();
  let diasUteis = 0;
  while (diasUteis < 5) {
    data.setDate(data.getDate() + 1);
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) {
      diasUteis++;
    }
  }
  return data.toISOString().split('T')[0];
}

async function buscarClientNumber(lojistaId) {
  try {
    if (!db) return null;
    const doc = await db.collection('lojistas').doc(lojistaId).get();
    return doc.data()?.clientNumber || null;
  } catch (error) {
    console.error('Erro ao buscar clientNumber:', error);
    return null;
  }
}

async function obterTokenSantander() {
  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SANTANDER_CLIENT_ID,
        client_secret: process.env.SANTANDER_CLIENT_SECRET
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('Erro ao obter token:', error.message);
    throw new Error('Falha na autenticação Santander');
  }
}

async function criarWorkspace(accessToken) {
  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {},
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': process.env.SANTANDER_CLIENT_ID
        }
      }
    );
    return response.data.workspaceId;
  } catch (error) {
    console.error('Erro ao criar workspace:', error.message);
    throw new Error('Falha ao criar workspace');
  }
}

async function gerarNSU(clientNumber) {
  const timestamp = Date.now().toString();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${clientNumber}${timestamp.slice(-8)}${random}`;
}

function createHttpsAgent() {
  try {
    const certRaw = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyRaw = process.env.SANTANDER_PRIVATE_KEY_B64;
    const passphrase = process.env.SANTANDER_CERT_PASSWORD;

    if (!certRaw || !keyRaw) return null;

    const cleanPEM = (raw) => {
      if (raw.includes('-----BEGIN')) return raw.replace(/\\n/g, '\n');
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      return decoded.replace(/\\n/g, '\n');
    };

    return new https.Agent({
      cert: cleanPEM(certRaw),
      key: cleanPEM(keyRaw),
      passphrase: passphrase || undefined,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    });
  } catch (error) {
    console.error('❌ Erro ao criar Agente HTTPS:', error.message);
    return null;
  }
}

// =============================================
// ROTA: REGISTRAR BOLETO (COM MOCK PARA TESTE)
// =============================================
app.post('/api/santander/boletos', async (req, res) => {
  const { dadosBoleto, lojistaId } = req.body;
  
  console.log('📦 Recebendo requisição de boleto:');
  console.log('  - lojistaId:', lojistaId);
  console.log('  - dadosBoleto:', JSON.stringify(dadosBoleto).substring(0, 200));
  
  if (!dadosBoleto || !lojistaId) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  // MODO MOCK - Para testes sem certificado Santander
  const USE_MOCK = process.env.USE_MOCK === 'true' || true; // true para testes
  
  if (USE_MOCK) {
    console.log('🔧 Usando MOCK para boleto (modo desenvolvimento)');
    
    // Gerar dados mockados
    const mockBoletoId = `MOCK-${Date.now()}`;
    const mockDigitableLine = '23793.38128 60011.827468 12345.678902 1 12340000012345';
    const mockQrCodePix = `00020126360014br.gov.bcb.pix0114+5511999999999520400005303986540.005802BR5913${dadosBoleto.pagadorNome?.substring(0, 20) || 'Loja Teste'}6009SAO PAULO62070503***6304E2C8`;
    
    return res.json({
      success: true,
      data: {
        boletoId: mockBoletoId,
        digitableLine: mockDigitableLine,
        barCode: mockDigitableLine.replace(/\s/g, ''),
        nsuCode: `MOCK${Date.now()}`,
        qrCodePix: mockQrCodePix,
        dueDate: calcularCincoDiasUteis()
      },
      message: 'Boleto gerado em modo MOCK (teste)'
    });
  }

  // MODO REAL - Integração com Santander
  try {
    const clientNumber = await buscarClientNumber(lojistaId);
    if (!clientNumber) throw new Error('Lojista sem clientNumber cadastrado.');

    const accessToken = await obterTokenSantander();
    const workspaceId = await criarWorkspace(accessToken);
    const nsuCode = await gerarNSU(clientNumber);
    const bankNumber = nsuCode.slice(-7);

    const payload = {
      environment: "PRODUCAO",
      nsuCode: nsuCode,
      nsuDate: new Date().toISOString().split('T')[0],
      covenantCode: parseInt(process.env.SANTANDER_COVENANT_CODE || "178622"),
      bankNumber: bankNumber,
      clientNumber: clientNumber.toString().padStart(5, "0"),
      dueDate: calcularCincoDiasUteis(),
      issueDate: new Date().toISOString().split('T')[0],
      participantCode: "00000001",
      nominalValue: parseFloat(dadosBoleto.valor).toFixed(2),
      payer: {
        name: dadosBoleto.pagadorNome.toUpperCase().substring(0, 40),
        documentType: "CNPJ",
        documentNumber: dadosBoleto.pagadorDocumento.replace(/\D/g, ''),
        address: dadosBoleto.pagadorEndereco.toUpperCase().substring(0, 40),
        neighborhood: (dadosBoleto.bairro || "CENTRO").toUpperCase().substring(0, 20),
        city: dadosBoleto.pagadorCidade.toUpperCase().substring(0, 20),
        state: dadosBoleto.pagadorEstado.toUpperCase().substring(0, 2),
        zipCode: dadosBoleto.pagadorCEP.replace(/\D/g, '').replace(/(\d{5})(\d{3})/, "$1-$2")
      },
      documentKind: "DUPLICATA_MERCANTIL",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      key: {
        type: "CNPJ",
        dictKey: (process.env.SANTANDER_DICT_KEY || "09199193000126").replace(/\D/g, '')
      }
    };

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': process.env.SANTANDER_CLIENT_ID
        },
        httpsAgent: createHttpsAgent()
      }
    );

    res.json({ success: true, data: response.data });

  } catch (error) {
    console.error("❌ Erro Santander:", error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Falha no processamento', 
      details: error.response?.data || error.message 
    });
  }
});

// =============================================
// ROTA: GERAR PDF DO BOLETO (MOCK)
// =============================================
app.post('/api/santander/boletos/pdf', async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;
  
  console.log('📄 Gerando PDF para boleto:', { digitableLine, payerDocumentNumber });
  
  // MODO MOCK - Retorna URL de teste
  const USE_MOCK = process.env.USE_MOCK === 'true' || true;
  
  if (USE_MOCK) {
    return res.json({
      success: true,
      link: `https://example.com/boleto-${Date.now()}.pdf`,
      message: 'PDF gerado em modo MOCK'
    });
  }
  
  // Aqui você implementaria a geração real do PDF
  res.json({ success: true, link: 'https://example.com/boleto.pdf' });
});

// =============================================
// ROTA: UPLOAD PARA CLOUDINARY (MOCK)
// =============================================
app.post('/api/cloudinary/upload-pdf', async (req, res) => {
  const { pdfUrl, fileName, boletoId } = req.body;
  
  console.log('☁️ Upload para Cloudinary:', { pdfUrl, fileName, boletoId });
  
  // MODO MOCK
  const USE_MOCK = process.env.USE_MOCK === 'true' || true;
  
  if (USE_MOCK) {
    return res.json({
      success: true,
      cloudinaryUrl: `https://res.cloudinary.com/demo/raw/upload/v1/${fileName}`,
      message: 'Upload realizado em modo MOCK'
    });
  }
  
  res.json({ success: true, cloudinaryUrl: `https://res.cloudinary.com/demo/raw/upload/v1/${fileName}` });
});

// =============================================
// INICIALIZAÇÃO
// =============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Test endpoint: http://localhost:${PORT}/test`);
  console.log(`📍 CORS permitido para: ${allowedOrigins.join(', ')}`);
});
