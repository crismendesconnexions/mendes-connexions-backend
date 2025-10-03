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
// CONFIGURAÇÃO CORS
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
app.options('*', cors(corsOptions));

// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`, { body: req.body, headers: req.headers });
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
  } else console.error('❌ FIREBASE_SERVICE_ACCOUNT não encontrado nas variáveis de ambiente');
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
}

// =============================================
// CONFIGURAÇÃO SANTANDER
// =============================================
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: parseInt(process.env.SANTANDER_COVENANT_CODE || "178622"),
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE || "REGISTRO12",
  DICT_KEY: process.env.SANTANDER_DICT_KEY || "09199193000126",
  CLIENT_NUMBER_FIXO: "00001" // <-- ClientNumber fixo de 5 dígitos
};

// =============================================
// AGENTE HTTPS SANTANDER
// =============================================
function createHttpsAgent() {
  try {
    const certBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;
    if (!certBase64 || !keyBase64) return null;

    const cert = Buffer.from(certBase64, 'base64').toString('utf-8');
    const key = Buffer.from(keyBase64, 'base64').toString('utf-8');

    return new https.Agent({ cert, key, rejectUnauthorized: true, keepAlive: true });
  } catch (error) {
    console.error('❌ Erro ao criar agente HTTPS:', error.message);
    return null;
  }
}

// =============================================
// FUNÇÕES AUXILIARES DE DATA
// =============================================
function calcularQuintoDiaUtilProximoMes() {
  const hoje = new Date();
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth() + 1;
  if (mes === 12) { mes = 1; ano += 1 } else { mes += 1 }
  const data = new Date(ano, mes - 1, 1);
  let diasUteis = 0;
  while (diasUteis < 5) {
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) diasUteis++;
    if (diasUteis === 5) break;
    data.setDate(data.getDate() + 1);
  }
  return data.toISOString().split('T')[0];
}

function gerarNsuDate() { return new Date().toISOString().split('T')[0]; }
function gerarIssueDate() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }
function gerarDiscountLimitDate() { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().split('T')[0]; }

// =============================================
// FUNÇÃO: OBTER TOKEN SANTANDER
// =============================================
async function obterTokenSantander() {
  const formData = new URLSearchParams({
    client_id: SANTANDER_CONFIG.CLIENT_ID,
    client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'collection_bill_management'
  });

  const httpsAgent = createHttpsAgent();
  if (!httpsAgent) throw new Error('Agente HTTPS não disponível');

  const response = await axios.post(
    'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
    formData,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, httpsAgent, timeout: 30000 }
  );

  return response.data.access_token;
}

// =============================================
// FUNÇÃO: CRIAR WORKSPACE
// =============================================
async function criarWorkspace(accessToken) {
  const payload = { type: "BILLING", description: "Workspace de Cobrança", covenants: [{ code: SANTANDER_CONFIG.COVENANT_CODE }] };
  const httpsAgent = createHttpsAgent();
  if (!httpsAgent) throw new Error('Agente HTTPS não disponível');

  const response = await axios.post(
    'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
    payload,
    { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID, 'Accept': 'application/json' }, httpsAgent, timeout: 30000 }
  );

  return response.data.id;
}

// =============================================
// ROTA: REGISTRAR BOLETO
// =============================================
app.post('/api/santander/boletos', async (req, res) => {
  const { dadosBoleto, lojistaId } = req.body;
  if (!dadosBoleto || !lojistaId)
    return res.status(400).json({ error: 'Dados do boleto ou ID do lojista não fornecidos' });

  try {
    // Busca lojista no Firebase
    const lojistaDoc = await db.collection('lojistas').doc(lojistaId).get();
    if (!lojistaDoc.exists) return res.status(400).json({ error: 'Lojista não encontrado' });

    const accessToken = await obterTokenSantander();
    const workspaceId = await criarWorkspace(accessToken);

    const dueDate = calcularQuintoDiaUtilProximoMes();
    const nsuDate = gerarNsuDate();
    const issueDate = gerarIssueDate();
    const discountLimitDate = gerarDiscountLimitDate();

    const payload = {
      environment: "PRODUCAO",
      nsuCode: `${SANTANDER_CONFIG.CLIENT_NUMBER_FIXO}${Date.now()}`,
      nsuDate,
      covenantCode: SANTANDER_CONFIG.COVENANT_CODE,
      bankNumber: "0036",
      clientNumber: SANTANDER_CONFIG.CLIENT_NUMBER_FIXO, // <-- fixo agora
      dueDate,
      issueDate,
      participantCode: SANTANDER_CONFIG.PARTICIPANT_CODE,
      nominalValue: parseFloat(dadosBoleto.valorCompra).toFixed(2),
      payer: {
        name: dadosBoleto.pagadorNome.toUpperCase(),
        documentType: "CNPJ",
        documentNumber: dadosBoleto.pagadorDocumento,
        address: dadosBoleto.pagadorEndereco.toUpperCase(),
        neighborhood: dadosBoleto.bairro.toUpperCase(),
        city: dadosBoleto.pagadorCidade.toUpperCase(),
        state: dadosBoleto.pagadorEstado.toUpperCase(),
        zipCode: dadosBoleto.pagadorCEP.replace(/(\d{5})(\d{3})/, "$1-$2")
      },
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: ["mensagem um", "mensagem dois"],
      key: { type: "CNPJ", dictKey: SANTANDER_CONFIG.DICT_KEY },
      discount: { type: "VALOR_DATA_FIXA", discountOne: { value: "0.50", limitDate: discountLimitDate } },
      interestPercentage: "05.00"
    };

    const httpsAgent = createHttpsAgent();
    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: { 'Content-Type': 'application/json', 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID, 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
        httpsAgent,
        timeout: 30000
      }
    );

    res.json({ success: true, message: 'Boleto registrado com sucesso', boletoId: boletoResponse.data.nsuCode, ...boletoResponse.data });
  } catch (error) {
    console.error("❌ Erro no fluxo Santander:", { message: error.message, status: error.response?.status, data: error.response?.data });
    res.status(500).json({ error: 'Falha no processo Santander', details: error.response?.data || error.message, step: 'registro_boleto' });
  }
});

// =============================================
// INICIALIZAÇÃO DO SERVIDOR
// =============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
  console.log('Ambiente:', process.env.NODE_ENV || 'development');
});
