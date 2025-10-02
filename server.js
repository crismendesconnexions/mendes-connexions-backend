// server.js (Produção)
require('dotenv').config();
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

// 🔐 Segurança
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.disable('x-powered-by');

// 🔹 CORS
app.use(cors({
  origin: [
    process.env.ALLOWED_ORIGIN_1,
    process.env.ALLOWED_ORIGIN_2
  ],
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
}));
app.options('*', cors());

// 🔹 JSON parser
app.use(express.json());

// 🔹 Health check
app.get('/health', (req,res)=>res.status(200).json({
  status:'ok',
  service:'Mendes Connexions Backend',
  timestamp:new Date().toISOString(),
  environment: process.env.NODE_ENV || 'production'
}));

// 🔹 Firebase Admin
if(process.env.FIREBASE_SERVICE_ACCOUNT){
  try{
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    console.log('✅ Firebase Admin inicializado');
  }catch(err){
    console.error('❌ Erro Firebase Admin:', err);
  }
}
const db = admin.firestore ? admin.firestore() : null;

// 🔹 Santander Config
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  APPLICATION_KEY: process.env.SANTANDER_APPLICATION_KEY,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE
};

// 🔹 Multer (Certificados)
const uploadDir = '/tmp/certificados';
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive:true });

const storage = multer.diskStorage({
  destination:(req,file,cb)=>cb(null,uploadDir),
  filename:(req,file,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(file.originalname))
});
const fileFilter = (req,file,cb)=>{
  const allowed = /(\.crt|\.key|\.pem)$/i;
  if(allowed.test(file.originalname)) cb(null,true);
  else cb(new Error('Apenas .crt, .key e .pem'));
};
const upload = multer({ storage, fileFilter, limits:{ fileSize:1024*1024*5 } });

// 🔹 Autenticação Firebase
const authenticate = async(req,res,next)=>{
  if(!admin.auth) return next();
  try{
    const token = req.headers.authorization?.split('Bearer ')[1];
    if(!token) return res.status(401).json({ error:'Token não fornecido' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  }catch(err){
    res.status(401).json({ error:'Token inválido' });
  }
};

// 🔹 HTTPS Agent Santander
function createHttpsAgent(){
  try{
    const cert = Buffer.from(process.env.SANTANDER_CERTIFICATE_CRT_B64,'base64').toString('utf-8');
    const key = Buffer.from(process.env.SANTANDER_PRIVATE_KEY_B64,'base64').toString('utf-8');
    return new https.Agent({ cert, key, rejectUnauthorized:true });
  }catch(err){
    console.error('❌ Erro criar HTTPS Agent:',err);
    return null;
  }
}

// 🔹 Funções Auxiliares
function gerarNumeroUnico(clientNumber){ return `${clientNumber}-${Date.now()}`; }
async function gerarBankNumberSequencial(){
  if(!db) return Math.floor(Math.random()*1e6);
  try{
    const counterRef = db.collection('counters').doc('bankNumber');
    return await db.runTransaction(async t=>{
      const doc = await t.get(counterRef);
      if(!doc.exists){ t.set(counterRef,{sequence:1}); return 1; }
      const seq = doc.data().sequence + 1;
      t.update(counterRef,{sequence:seq});
      return seq;
    });
  }catch(err){ console.error(err); return Math.floor(Math.random()*1e6); }
}
async function obterWorkspaceId(accessToken){
  try{
    const res = await axios.get(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      { headers:{ Authorization:`Bearer ${accessToken}`, 'X-Application-Key':SANTANDER_CONFIG.APPLICATION_KEY } }
    );
    if(res.data?.length>0) return res.data[0].id;
    const createRes = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      { name:'Workspace Principal', description:'Gestão de boletos' },
      { headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${accessToken}`, 'X-Application-Key':SANTANDER_CONFIG.APPLICATION_KEY } }
    );
    return createRes.data.id;
  }catch(err){ console.error('❌ Erro workspace:',err); return 'workspace-default'; }
}

// 🔹 Rotas
app.post('/api/upload-certificados', authenticate, upload.fields([{ name:'certificadoCrt', maxCount:1 },{ name:'certificadoKey', maxCount:1 }]), async(req,res)=>{
  if(!req.files || !req.files['certificadoCrt'] || !req.files['certificadoKey'])
    return res.status(400).json({ error:'Envie .crt e .key' });
  res.json({ success:true, arquivos:{ crt:req.files['certificadoCrt'][0].filename, key:req.files['certificadoKey'][0].filename } });
});

app.post('/api/santander/token', authenticate, async(req,res)=>{
  try{
    const form = new URLSearchParams();
    form.append('client_id',SANTANDER_CONFIG.CLIENT_ID);
    form.append('client_secret',SANTANDER_CONFIG.CLIENT_SECRET);
    form.append('grant_type','client_credentials');
    const tokenRes = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      form,
      { headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, httpsAgent:createHttpsAgent() }
    );
    res.json(tokenRes.data);
  }catch(err){
    console.error('❌ Token Santander:',err.response?.data || err.message);
    res.status(500).json({ error:'Falha ao obter token', details:err.response?.data || err.message });
  }
});

app.post('/api/santander/boletos', authenticate, async(req,res)=>{
  const { dadosBoleto } = req.body;
  if(!dadosBoleto) return res.status(400).json({ error:'Dados não fornecidos' });

  try{
    const valor = parseFloat(dadosBoleto.valor);
    if(isNaN(valor)) throw new Error('Valor inválido');
    const dataVenc = new Date(dadosBoleto.dataVencimento);
    if(isNaN(dataVenc.getTime())) throw new Error('Data vencimento inválida');

    const payload = {
      nsuCode: gerarNumeroUnico(dadosBoleto.clientNumber),
      bankNumber: await gerarBankNumberSequencial(),
      valor,
      dataVencimento: dataVenc.toISOString().split('T')[0],
      pagador:{
        nome:dadosBoleto.pagadorNome,
        documento:dadosBoleto.pagadorDocumento,
        endereco:dadosBoleto.pagadorEndereco,
        cidade:dadosBoleto.pagadorCidade,
        estado:dadosBoleto.pagadorEstado,
        cep:dadosBoleto.pagadorCEP
      }
    };

    const form = new URLSearchParams();
    form.append('client_id',SANTANDER_CONFIG.CLIENT_ID);
    form.append('client_secret',SANTANDER_CONFIG.CLIENT_SECRET);
    form.append('grant_type','client_credentials');

    const tokenRes = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      form,
      { headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, httpsAgent:createHttpsAgent() }
    );
    const accessToken = tokenRes.data.access_token;
    const workspaceId = await obterWorkspaceId(accessToken);

    const boletoRes = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      { headers:{ 'Content-Type':'application/json', 'X-Application-Key':SANTANDER_CONFIG.APPLICATION_KEY, Authorization:`Bearer ${accessToken}` }, httpsAgent:createHttpsAgent() }
    );

    if(db){
      const ref = await db.collection('boletos').add({ ...payload, workspaceId, dataCriacao:new Date(), status:'pendente' });
      res.json({ ...boletoRes.data, id:ref.id });
    }else res.json(boletoRes.data);

  }catch(err){
    console.error('❌ Erro registrar boleto:',err.response?.data || err.message);
    res.status(500).json({ error:'Falha ao registrar boleto', details:err.response?.data || err.message });
  }
});

app.post('/api/santander/boletos/pdf', authenticate, async(req,res)=>{
  const { digitableLine, payerDocumentNumber } = req.body;
  if(!digitableLine || !payerDocumentNumber) return res.status(400).json({ error:'Linha digitável e documento obrigatórios' });

  try{
    const form = new URLSearchParams();
    form.append('client_id',SANTANDER_CONFIG.CLIENT_ID);
    form.append('client_secret',SANTANDER_CONFIG.CLIENT_SECRET);
    form.append('grant_type','client_credentials');

    const tokenRes = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      form,
      { headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, httpsAgent:createHttpsAgent() }
    );
    const accessToken = tokenRes.data.access_token;

    const pdfRes = await axios({
      method:'post',
      url:`https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      data:{ payerDocumentNumber },
      headers:{ 'Content-Type':'application/json', 'X-Application-Key':SANTANDER_CONFIG.APPLICATION_KEY, Authorization:`Bearer ${accessToken}` },
      responseType:'arraybuffer',
      httpsAgent:createHttpsAgent()
    });

    res.set({
      'Content-Type':'application/pdf',
      'Content-Disposition':`attachment; filename="boleto-${digitableLine}.pdf"`,
      'Content-Length': pdfRes.data.length
    });
    res.send(Buffer.from(pdfRes.data));

  }catch(err){
    console.error('❌ Erro gerar PDF:',err.response?.data || err.message);
    res.status(500).json({ error:'Falha ao gerar PDF', details:err.message });
  }
});

// 🔹 Handlers de erro globais
app.use((req,res)=>res.status(404).json({ error:'Rota não encontrada' }));
app.use((err,req,res,next)=>{
  console.error('Erro global:',err.stack);
  if(err instanceof multer.MulterError){
    if(err.code==='LIMIT_FILE_SIZE') return res.status(400).json({ error:'Arquivo > 5MB' });
    if(err.code==='LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error:'Campo de arquivo inesperado' });
  }
  res.status(500).json({ error:'Erro interno' });
});

// 🔹 Inicialização
const PORT = process.env.PORT || 3001;
app.listen(PORT,'0.0.0.0',()=>console.log(`Servidor rodando na porta ${PORT}, ambiente: ${process.env.NODE_ENV || 'production'}`));
