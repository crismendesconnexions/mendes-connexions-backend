// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet'); // 🔐 Middleware de segurança

const app = express();

// 🔐 Configurações de Segurança
app.use(helmet()); // Aplica headers de segurança HTTP :cite[4]
app.disable('x-powered-by'); // Reduz fingerprinting do servidor :cite[4]

app.use(cors());
app.use(express.json());

// 🔹 Inicializar Firebase Admin usando variável de ambiente
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err);
    process.exit(1);
  }
} else {
  console.error('FIREBASE_SERVICE_ACCOUNT não definido!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET // Adicione esta variável de ambiente
});
const db = admin.firestore();

// 🔹 Credenciais Santander (seguras no backend)
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE,
  DICT_KEY: process.env.SANTANDER_DICT_KEY
};

// 🔹 Configuração do Multer para Upload de Certificados
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, '/tmp/certificados'); // Usa diretório temporário no Render
  },
  filename: function (req, file, cb) {
    const nomeUnico = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, nomeUnico);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/x-x509-ca-cert' ||
      file.originalname.match(/\.(crt|key|pem)$/)) {
    cb(null, true);
  } else {
    cb(new Error('Apenas arquivos de certificado (.crt, .key, .pem) são permitidos!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 5 // Limite de 5MB
  }
});

// 🔹 Middleware de autenticação
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

// 🔹 Handler assíncrono para evitar código repetitivo :cite[9]
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 🔹 Rota para upload de certificados
app.post('/api/upload-certificados', authenticate, upload.fields([
  { name: 'certificadoCrt', maxCount: 1 },
  { name: 'certificadoKey', maxCount: 1 }
]), asyncHandler(async (req, res) => {
  if (!req.files || !req.files['certificadoCrt'] || !req.files['certificadoKey']) {
    return res.status(400).json({ error: 'Envie ambos os arquivos: .crt e .key' });
  }

  const fileCrt = req.files['certificadoCrt'][0];
  const fileKey = req.files['certificadoKey'][0];

  // Aqui você pode fazer o upload para o Firebase Storage se desejar :cite[8]:cite[10]
  // const bucket = admin.storage().bucket();
  // await bucket.upload(fileCrt.path, { destination: `certificados/${fileCrt.filename}` });
  // await bucket.upload(fileKey.path, { destination: `certificados/${fileKey.filename}` });

  res.json({
    success: true,
    message: 'Certificados recebidos com sucesso!',
    arquivos: {
      crt: fileCrt.filename,
      key: fileKey.filename
    }
  });
}));

// 🔹 Rota para obter token Santander (ATUALIZADA com suporte a certificados)
app.post('/api/santander/token', authenticate, asyncHandler(async (req, res) => {
  const formData = new URLSearchParams();
  formData.append('client_id', SANTANDER_CONFIG.CLIENT_ID);
  formData.append('client_secret', SANTANDER_CONFIG.CLIENT_SECRET);
  formData.append('grant_type', 'client_credentials');

  const config = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  // 🔹 Se você tiver certificados, adicione esta configuração:
  // const https = require('https');
  // const fs = require('fs');
  // config.httpsAgent = new https.Agent({
  //   cert: fs.readFileSync('/caminho/para/seu/certificado.crt'),
  //   key: fs.readFileSync('/caminho/para/sua/chave.key')
  // });

  const response = await axios.post(
    'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
    formData,
    config
  );

  res.json(response.data);
}));

// 🔹 Rota para registrar boleto (usando asyncHandler)
app.post('/api/santander/boletos', authenticate, asyncHandler(async (req, res) => {
  const { dadosBoleto } = req.body;

  // Obter token primeiro
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

  const payload = {
    // Seu payload para o boleto aqui
    nsuCode: nsuCode,
    bankNumber: bankNumber,
    // ... outros campos do boleto
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
}));

// 🔹 Rota para gerar PDF do boleto (usando asyncHandler)
app.post('/api/santander/boletos/pdf', authenticate, asyncHandler(async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;

  const tokenResponse = await axios.post(
    'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
    new URLSearchParams({
      client_id: SANTANDER_CONFIG.CIENT_ID,
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
}));

// 🔹 Funções auxiliares
function gerarNumeroUnico(clientNumber) {
  return `${clientNumber}-${Date.now()}`;
}

async function gerarBankNumberSequencial() {
  // Implementação real usando banco de dados
  return Math.floor(Math.random() * 1000000);
}

async function obterWorkspaceId(accessToken) {
  // Implementação para obter ou criar workspace
  return 'workspace-id-exemplo';
}

// 🔹 Handlers de erro globais :cite[4]
app.use((req, res, next) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo muito grande. Limite é 5MB.' });
    }
  }
  
  res.status(500).json({ error: 'Algo deu errado no servidor!' });
});

// 🔹 Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend online',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
