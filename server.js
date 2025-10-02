// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs');
const https = require('https');

const app = express();

// 🔐 Configurações de Segurança
app.use(helmet({
  contentSecurityPolicy: false, // Desabilita CSP para facilitar desenvolvimento
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.disable('x-powered-by');

// 🔹 Configuração CORS CORRETA para produção
app.use(cors({
  origin: [
    'https://mendesconnexions.com.br',
    'https://www.mendesconnexions.com.br'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// 🔹 ESTA LINHA É OBRIGATÓRIA
app.options('*', cors());

app.use(express.json());
// 🔹 Health Check - DEVE vir antes de qualquer outra configuração
app.get('/health', (req, res) => {
  const healthStatus = {
    status: 'ok',
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)} segundos`
  };
  
  res.status(200).json(healthStatus);
});

// 🔹 Rota de teste sem autenticação
app.get('/test', (req, res) => {
  res.status(200).json({
    message: 'Backend está respondendo sem autenticação',
    status: 'success',
    timestamp: new Date().toISOString()
  });
});

// 🔹 Inicializar Firebase Admin usando variável de ambiente
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err);
    // Não encerre o processo, apenas registre o erro
    console.log('Continuando sem Firebase...');
  }
} else {
  console.error('FIREBASE_SERVICE_ACCOUNT não definido!');
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    console.log('Firebase Admin inicializado com sucesso');
  } catch (error) {
    console.error('Erro ao inicializar Firebase Admin:', error);
  }
}

const db = admin.firestore ? admin.firestore() : null;

// 🔹 Credenciais Santander (seguras no backend)
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE,
  DICT_KEY: process.env.SANTANDER_DICT_KEY
};

// 🔹 Configuração do Multer para Upload de Certificados
const uploadDir = '/tmp/certificados';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const nomeUnico = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, nomeUnico);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = /(\.crt|\.key|\.pem)$/i;
  const allowedMimes = [
    'application/x-x509-ca-cert',
    'application/x-pem-file',
    'text/plain'
  ];

  if (allowedMimes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
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

// 🔹 Middleware de autenticação (apenas se Firebase estiver disponível)
const authenticate = async (req, res, next) => {
  // Se não há Firebase configurado, permita a requisição
  if (!admin.auth) {
    return next();
  }
  
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

// 🔹 Handler assíncrono para evitar código repetitivo
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

  console.log('Certificado CRT salvo em:', fileCrt.path);
  console.log('Chave KEY salva em:', fileKey.path);

  res.json({
    success: true,
    message: 'Certificados recebidos com sucesso!',
    arquivos: {
      crt: fileCrt.filename,
      key: fileKey.filename
    }
  });
}));

// 🔹 Função para criar agente HTTPS com certificados
function createHttpsAgent() {
  try {
    // Use as variáveis de ambiente que você já configurou no Render
    const certContent = process.env.SANTANDER_CERTIFICATE_CRT;
    const keyContent = process.env.SANTANDER_PRIVATE_KEY;
    
    if (!certContent || !keyContent) {
      console.warn('Certificados não encontrados nas variáveis de ambiente, usando conexão padrão');
      return null;
    }

    return new https.Agent({
      cert: certContent,
      key: keyContent,
      rejectUnauthorized: false
    });
  } catch (error) {
    console.error('Erro ao criar agente HTTPS:', error);
    return null;
  }
}

// 🔹 Rota para obter token Santander
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

  // 🔹 Usar certificados das variáveis de ambiente
  const httpsAgent = createHttpsAgent();
  if (httpsAgent) {
    config.httpsAgent = httpsAgent;
  }

  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      config
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro detalhado ao obter token Santander:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Erro mais específico para ajudar no diagnóstico
    let errorMessage = 'Falha ao obter token';
    if (error.response?.status === 404) {
      errorMessage = 'Endpoint não encontrado - verifique a URL da API Santander';
    } else if (error.response?.status === 401) {
      errorMessage = 'Autenticação falhou - verifique credenciais e certificados';
    }
    
    res.status(500).json({
      error: errorMessage,
      details: error.response?.data || error.message
    });
  }
}));

// 🔹 Rota para registrar boleto (CORRIGIDA)
app.post('/api/santander/boletos', authenticate, asyncHandler(async (req, res) => {
  const { dadosBoleto } = req.body;

  if (!dadosBoleto) {
    return res.status(400).json({ error: 'Dados do boleto não fornecidos' });
  }

  try {
    // CORREÇÃO: Use CLIENT_ID correto (não CIENT_ID)
      const basicAuth = Buffer.from(
        `${SANTANDER_CONFIG.CLIENT_ID}:${SANTANDER_CONFIG.CLIENT_SECRET}`
      ).toString('base64');

      const tokenResponse = await axios.post(
        'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
        new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'urn:opc:resource:token'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${basicAuth}`
          },
          httpsAgent: createHttpsAgent() // ✅ se precisar dos certificados
        }
      );

    
    const accessToken = tokenResponse.data.access_token;
    const workspaceId = await obterWorkspaceId(accessToken);

    const nsuCode = gerarNumeroUnico(dadosBoleto.clientNumber);
    const bankNumber = await gerarBankNumberSequencial();

    const payload = {
      nsuCode: nsuCode,
      bankNumber: bankNumber,
      valor: dadosBoleto.valor,
      pagador: {
        nome: dadosBoleto.pagadorNome,
        documento: dadosBoleto.pagadorDocumento,
        endereco: dadosBoleto.pagadorEndereco,
        cidade: dadosBoleto.pagadorCidade,
        estado: dadosBoleto.pagadorEstado,
        cep: dadosBoleto.pagadorCEP
      },
      dataVencimento: dadosBoleto.dataVencimento,
      ...dadosBoleto
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

    // Salvar no Firestore apenas se estiver disponível
    if (db) {
      const boletoRef = await db.collection('boletos').add({
        ...payload,
        workspaceId: workspaceId,
        dataCriacao: new Date(),
        status: 'pendente'
      });

      res.json({
        ...boletoResponse.data,
        id: boletoRef.id
      });
    } else {
      res.json(boletoResponse.data);
    }

  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Falha ao registrar boleto',
      details: error.response?.data || error.messagea
    });
  }
}));

// 🔹 Rota para gerar PDF do boleto (CORRIGIDA)
app.post('/api/santander/boletos/pdf', authenticate, asyncHandler(async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;

  if (!digitableLine || !payerDocumentNumber) {
    return res.status(400).json({ error: 'Linha digitável e documento do pagador são obrigatórios' });
  }

  try {
    // CORREÇÃO: Use CLIENT_ID correto aqui também
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID, // ✅ CORRETO
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    const accessToken = tokenResponse.data.access_token;

    // CORREÇÃO: Mudança no tratamento do responseType para PDF
    const pdfResponse = await axios({
      method: 'post',
      url: `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      data: { payerDocumentNumber },
      headers: {
        'Content-Type': 'application/json',
        'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`
      },
      responseType: 'arraybuffer' // Melhor para PDF
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="boleto-${digitableLine}.pdf"`,
      'Content-Length': pdfResponse.data.length
    });

    res.send(Buffer.from(pdfResponse.data));

  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Falha ao gerar PDF',
      details: error.message
    });
  }
}));

// 🔹 Funções auxiliares (mantidas iguais)
function gerarNumeroUnico(clientNumber) {
  return `${clientNumber}-${Date.now()}`;
}

async function gerarBankNumberSequencial() {
  if (!db) return Math.floor(Math.random() * 1000000);
  
  try {
    const counterRef = db.collection('counters').doc('bankNumber');
    const counter = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      if (!doc.exists) {
        transaction.set(counterRef, { sequence: 1 });
        return 1;
      }
      const newSequence = doc.data().sequence + 1;
      transaction.update(counterRef, { sequence: newSequence });
      return newSequence;
    });
    return counter;
  } catch (error) {
    console.error('Erro ao gerar sequencial:', error);
    return Math.floor(Math.random() * 1000000);
  }
}

async function obterWorkspaceId(accessToken) {
  try {
    const response = await axios.get(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        }
      }
    );
    
    if (response.data && response.data.length > 0) {
      return response.data[0].id;
    }
    
    const createResponse = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        name: 'Workspace Principal',
        description: 'Workspace para gestão de boletos'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        }
      }
    );
    
    return createResponse.data.id;
  } catch (error) {
    console.error('Erro ao obter workspace:', error);
    return 'workspace-default';
  }
}

// 🔹 Handlers de erro globais
app.use((req, res, next) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo muito grande. Limite é 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Campo de arquivo inesperado.' });
    }
  }
  
  res.status(500).json({ error: 'Algo deu errado no servidor!' });
});

// 🔹 Inicialização do servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check disponível em: http://0.0.0.0:${PORT}/health`);
});
