<script>
   document.addEventListener('DOMContentLoaded', function() {
     // URL da API backend
     const API_BASE_URL = 'https://mendes-connexions-backend.onrender.com';

     // Variáveis globais
     let lojistaData = {};
     let lojistaId = '';
     let profissionaisAtivos = [];
     let vendedoresAtivos = [];
     let currentBoletoData = null;
     let currentQrCodeData = null;

     // Elementos da DOM
     const menuToggle = document.getElementById('menu-toggle');
     const sidebar = document.getElementById('sidebar');
     const sidebarUserName = document.getElementById('sidebar-user-name');
     const sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
     const logoutBtn = document.getElementById('sidebar-logout-btn');
     const qrCodeModal = document.getElementById('qrCodeModal');
     const copyQrCodeBtn = document.getElementById('copyQrCode');
     const closeModalBtn = document.getElementById('closeModal');

     // --- Lógica de Logout ---
     if (logoutBtn) {
       logoutBtn.addEventListener('click', function(e) {
         e.preventDefault();
         if (confirm('Tem certeza que deseja sair?')) {
           auth.signOut().then(function() {
             window.location.href = 'dashboard.html';
           }).catch(function(error) {
             console.error('Erro ao fazer logout:', error);
             alert('Erro ao sair. Tente novamente.');
           });
         }
       });
     }

     // --- Lógica do Modal QR Code ---
     if (closeModalBtn) {
       closeModalBtn.addEventListener('click', function() {
         qrCodeModal.classList.remove('active');
       });
     }
     if (copyQrCodeBtn) {
       copyQrCodeBtn.addEventListener('click', copiarCodigoPix);
     }
     qrCodeModal.addEventListener('click', function(e) {
       if (e.target === qrCodeModal) {
         qrCodeModal.classList.remove('active');
       }
     });

     // --- Teste de Conexão com Backend ---
     console.log('=== INICIANDO VERIFICAÇÃO DE CONEXÃO ===');
     fetch(`${API_BASE_URL}/health`)
       .then(response => {
         console.log('Health Check Status:', response.status);
         if (!response.ok) throw new Error(`HTTP ${response.status}`);
         return response.json();
       })
       .then(data => console.log('Health Check Response:', data))
       .catch(error => console.error('Erro no Health Check:', error));

     // --- Lógica do Menu Mobile ---
     if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
            sidebar.classList.toggle('active');
        });
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 &&
                sidebar.classList.contains('active') &&
                !sidebar.contains(e.target) &&
                !menuToggle.contains(e.target)) {
            sidebar.classList.remove('active');
            }
        });
     }

     // --- Inicialização de Máscaras e Data ---
     try {
        $('#valor-compra').mask('000.000.000.000.000,00', {reverse: true});
     } catch (e) {
         console.warn("jQuery Mask não carregado:", e);
     }
     
     const dataReferenciaInput = document.getElementById('data-referencia');
     if (dataReferenciaInput) {
        dataReferenciaInput.valueAsDate = new Date();
     }

     // --- Status de Integração ---
     const statusDiv = document.getElementById('integration-status');
     const messageSpan = document.getElementById('integration-message');
     if (statusDiv && messageSpan) {
        statusDiv.className = 'integration-status integration-warning';
        messageSpan.innerHTML = '<i class="fas fa-sync-alt fa-spin mr-2"></i>Verificando conexão...';
        statusDiv.style.display = 'block';
     }

     // --- Configuração dos Selects Personalizados ---
     function configurarSelectPersonalizado() {
        ['profissional', 'vendedor'].forEach(tipo => {
            const trigger = document.getElementById(`${tipo}-select-trigger`);
            const options = document.getElementById(`${tipo}-select-options`);
            const search = document.getElementById(`search-${tipo}`);

            if (trigger && options && search) {
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const outroTipo = tipo === 'profissional' ? 'vendedor' : 'profissional';
                    document.getElementById(`${outroTipo}-select-options`)?.classList.remove('active');
                    options.classList.toggle('active');
                    if (options.classList.contains('active')) {
                        search.focus();
                        search.value = '';
                        const event = new Event('input', { bubbles: true, cancelable: true });
                        search.dispatchEvent(event);
                    }
                });
                options.addEventListener('click', (e) => e.stopPropagation());
            }
        });
        
        document.addEventListener('click', (e) => {
            document.getElementById('profissional-select-options')?.classList.remove('active');
            document.getElementById('vendedor-select-options')?.classList.remove('active');
        });
     }

     // --- Verificação de Autenticação ---
     auth.onAuthStateChanged(async function(user) {
       if (user) {
         lojistaId = user.uid;
         console.log('Usuário autenticado:', lojistaId);
         try {
             await Promise.all([
                 carregarDadosLojista(lojistaId),
                 carregarProfissionaisAtivos(),
                 carregarVendedoresAtivos()
             ]);
             await carregarHistoricoPontuacoes();
             configurarSelectPersonalizado();
             await testarConexaoBackend();
             
             if (statusDiv && messageSpan) {
                statusDiv.className = 'integration-status integration-success';
                messageSpan.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Conectado com sucesso';
             }
         } catch (error) {
             console.error('Erro durante a carga inicial:', error);
             if (statusDiv && messageSpan) {
                statusDiv.className = 'integration-status integration-error';
                messageSpan.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Erro na inicialização';
             }
         }
       } else {
         console.log('Usuário não autenticado, redirecionando...');
         window.location.href = 'dashboard.html';
       }
     });

     // --- Funções de Carga de Dados ---
     async function carregarDadosLojista(userId) {
       try {
         const lojistaDoc = await db.collection('lojistas').doc(userId).get();
         if (lojistaDoc.exists) {
           lojistaData = lojistaDoc.data();
           console.log("Dados do lojista carregados:", lojistaData);
           if (sidebarUserName) sidebarUserName.textContent = lojistaData.nomeFantasia || lojistaData.nome || 'Lojista';
           if (sidebarUserAvatar) {
             sidebarUserAvatar.innerHTML = lojistaData.logoURL
               ? `<img src="${lojistaData.logoURL}" alt="Logo">`
               : '<i class="fas fa-store"></i>';
           }
         } else {
           console.error('Dados do lojista não encontrados para ID:', userId);
         }
       } catch (error) {
         console.error('Erro ao carregar dados do lojista:', error);
       }
     }

     async function carregarProfissionaisAtivos() {
        try {
            const snapshot = await db.collection('profissionais')
                                    .where('status', '==', 'aprovado')
                                    .orderBy('nome')
                                    .get();
            profissionaisAtivos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            console.log(`Carregados ${profissionaisAtivos.length} profissionais ativos.`);
            const optionsContainer = document.getElementById('profissional-options-list');
            if (optionsContainer) {
                optionsContainer.innerHTML = '';
                if (profissionaisAtivos.length === 0) {
                    optionsContainer.innerHTML = '<div class="select-option text-gray-500">Nenhum profissional aprovado encontrado</div>';
                } else {
                    profissionaisAtivos.forEach(p => optionsContainer.appendChild(criarOpcaoSelectPersonalizado(p, 'profissional')));
                }
                configurarBuscaSelectPersonalizado('search-profissional', 'profissional-options-list', profissionaisAtivos, 'profissional');
            }
        } catch (error) {
            console.error('Erro ao carregar profissionais ativos:', error);
            const optionsContainer = document.getElementById('profissional-options-list');
            if(optionsContainer) optionsContainer.innerHTML = '<div class="select-option text-red-500">Erro ao carregar</div>';
        }
    }

     async function carregarVendedoresAtivos() {
         if (!lojistaId) return;
         try {
             const snapshot = await db.collection('vendedores')
                                     .where('lojistaId', '==', lojistaId)
                                     .orderBy('nome')
                                     .get();
             vendedoresAtivos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
             console.log(`Carregados ${vendedoresAtivos.length} vendedores.`);
             const optionsContainer = document.getElementById('vendedor-options-list');
             if (optionsContainer) {
                 optionsContainer.innerHTML = '';
                 if (vendedoresAtivos.length === 0) {
                     optionsContainer.innerHTML = '<div class="select-option text-gray-500">Nenhum vendedor cadastrado</div>';
                 } else {
                     vendedoresAtivos.forEach(v => optionsContainer.appendChild(criarOpcaoSelectPersonalizado(v, 'vendedor')));
                 }
                 configurarBuscaSelectPersonalizado('search-vendedor', 'vendedor-options-list', vendedoresAtivos, 'vendedor');
             }
         } catch (error) {
             console.error('Erro ao carregar vendedores:', error);
             const optionsContainer = document.getElementById('vendedor-options-list');
             if(optionsContainer) optionsContainer.innerHTML = '<div class="select-option text-red-500">Erro ao carregar</div>';
         }
     }

     // --- Funções Auxiliares ---
     function criarOpcaoSelectPersonalizado(item, tipo) {
       const div = document.createElement('div');
       div.className = 'select-option';
       div.setAttribute('data-id', item.id);
       div.setAttribute('data-nome', item.nome);

       let cpfFormatado = 'Não informado';
       if (item.cpf) {
           const cpfLimpo = item.cpf.toString().replace(/\D/g, '').padStart(11, '0');
           if (cpfLimpo.length === 11) {
             cpfFormatado = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
           }
       }

       let imagemHTML = '';
       let detalhes = '';

       if (tipo === 'profissional') {
         imagemHTML = item.fotoPerfilURL
           ? `<img src="${item.fotoPerfilURL}" class="select-option-image" alt="${item.nome}" onerror="this.style.display='none'">`
           : `<div class="select-option-image"><i class="fas fa-user"></i></div>`;
         detalhes = `${item.tipoProfissional || 'Profissional'} | CPF: ${cpfFormatado}`;
       } else if (tipo === 'vendedor') {
         imagemHTML = item.fotoURL
           ? `<img src="${item.fotoURL}" class="select-option-image" alt="${item.nome}" onerror="this.style.display='none'">`
           : `<div class="select-option-image"><i class="fas fa-user-tie"></i></div>`;
         detalhes = `${item.funcao || 'Vendedor'} | CPF: ${cpfFormatado}`;
       }

       div.innerHTML = `
         ${imagemHTML}
         <div class="select-option-info">
           <div class="select-option-name">${item.nome || 'Nome não disponível'}</div>
           <div class="select-option-details">${detalhes}</div>
         </div>
       `;

       div.addEventListener('click', function() {
         const trigger = document.getElementById(`${tipo}-select-trigger`);
         const inputId = document.getElementById(`${tipo}-id`);
         const optionsContainer = document.getElementById(`${tipo}-select-options`);

         if (trigger) trigger.querySelector('span').textContent = this.getAttribute('data-nome');
         if (inputId) inputId.value = this.getAttribute('data-id');
         if (optionsContainer) optionsContainer.classList.remove('active');
       });

       return div;
     }

     function configurarBuscaSelectPersonalizado(inputId, optionsListId, items, tipo) {
        const searchInput = document.getElementById(inputId);
        const optionsList = document.getElementById(optionsListId);

        if (!searchInput || !optionsList) return;

        searchInput.addEventListener('input', function() {
            const searchTerm = this.value.toLowerCase().trim();
            optionsList.innerHTML = '';

            const filteredItems = items.filter(item => {
                const nome = item.nome?.toLowerCase() || '';
                const cpf = item.cpf?.replace(/\D/g, '') || '';
                const tipoProf = tipo === 'profissional' ? (item.tipoProfissional?.toLowerCase() || '') : '';
                const funcaoVend = tipo === 'vendedor' ? (item.funcao?.toLowerCase() || '') : '';

                return nome.includes(searchTerm) ||
                       cpf.includes(searchTerm) ||
                       (tipo === 'profissional' && tipoProf.includes(searchTerm)) ||
                       (tipo === 'vendedor' && funcaoVend.includes(searchTerm));
            });

            if (filteredItems.length === 0) {
                optionsList.innerHTML = '<div class="select-option text-gray-500 p-4">Nenhum resultado encontrado</div>';
            } else {
                filteredItems.forEach(item => {
                    optionsList.appendChild(criarOpcaoSelectPersonalizado(item, tipo));
                });
            }
        });
     }

     // --- Funções de Teste de Conexão ---
     async function testarConexaoBackend() {
        try {
            const response = await fetch(`${API_BASE_URL}/health`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            console.log('✅ Conexão com backend estabelecida:', data);
            return true;
        } catch (error) {
            console.error('❌ Falha na conexão com backend:', error);
            return false;
        }
     }

     // --- Função de Download Automático ---
     async function baixarPdfAutomaticamente(pdfUrl, fileName) {
        try {
            console.log('📥 Iniciando download automático:', pdfUrl);
            const link = document.createElement('a');
            link.href = pdfUrl;
            link.download = fileName;
            link.target = '_blank';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            console.log('✅ Download automático iniciado');
        } catch (error) {
            console.error('❌ Erro no download automático:', error);
        }
     }

     // --- Funções Principais de Negócio ---
     async function registrarBoletoSantander(requestData) {
       try {
         const user = auth.currentUser;
         if (!user) throw new Error('Usuário não autenticado');
         const token = await user.getIdToken();
         console.log('📤 Enviando dados para registro de boleto:', requestData);
         const response = await fetch(`${API_BASE_URL}/api/santander/boletos`, {
           method: 'POST',
           headers: {
               'Content-Type': 'application/json',
               'Authorization': `Bearer ${token}`
           },
           body: JSON.stringify(requestData)
         });
         
         console.log('📥 Status do registro:', response.status);
         const responseData = await response.json();
         
         if (!response.ok) {
           console.error('❌ Erro da API Santander:', responseData);
           throw new Error(responseData.details || responseData.error || `Erro ${response.status}`);
         }
         
         console.log('✅ Boleto registrado com sucesso:', responseData);
         return responseData;
       } catch (error) {
         console.error('💥 Erro ao registrar boleto:', error);
         throw error;
       }
     }

     async function gerarPdfBoleto(digitableLine, payerDocumentNumber) {
        try {
            const user = auth.currentUser;
            if (!user) throw new Error('Usuário não autenticado');
            const token = await user.getIdToken();
            console.log('📄 Solicitando PDF do boleto:', { digitableLine });
            
            const response = await fetch(`${API_BASE_URL}/api/santander/boletos/pdf`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    digitableLine: digitableLine,
                    payerDocumentNumber: payerDocumentNumber
                })
            });
            
            console.log('📥 Status da resposta PDF:', response.status);
            const responseData = await response.json();
            
            if (!response.ok) {
                console.error('❌ Erro ao gerar PDF:', responseData);
                throw new Error(responseData.details || responseData.error || `Erro ${response.status}`);
            }
            
            if (!responseData.link) {
                throw new Error('Link do PDF não retornado');
            }
            
            console.log('✅ Link PDF gerado:', responseData.link);
            return responseData.link;
        } catch (error) {
            console.error('💥 Erro ao gerar PDF:', error);
            throw error;
        }
    }

    async function uploadPdfParaCloudinary(pdfUrl, fileName, pontuacaoId) {
        return new Promise(async (resolve, reject) => {
            try {
                console.log('☁️ Iniciando upload para Cloudinary:', fileName);
                const user = auth.currentUser;
                if (!user) throw new Error('Usuário não autenticado');
                const token = await user.getIdToken();

                const response = await fetch(`${API_BASE_URL}/api/cloudinary/upload-pdf`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        pdfUrl,
                        fileName,
                        pontuacaoId
                    })
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.details || result.error || `Erro ${response.status}`);
                }

                console.log('✅ Upload realizado:', result);

                // Salvar URL no Firebase
                await db.collection('pontuacoes').doc(pontuacaoId).update({
                    boletoPdfUrl: result.cloudinaryUrl,
                    boletoDownloadUrl: result.cloudinaryUrl,
                    boletoViewUrl: result.cloudinaryUrl,
                    boletoPublicId: result.publicId
                });

                console.log('✅ URL salva no Firebase');
                resolve(result.cloudinaryUrl);

            } catch (error) {
                console.error('❌ Erro no upload:', error);
                reject(error);
            }
        });
    }

    async function processarBoletoCompleto(requestData, pontuacaoRef) {
        try {
            console.log('🔄 Iniciando processo completo do boleto...');

            // 1. Registrar boleto no Santander
            const boletoResponse = await registrarBoletoSantander(requestData);
            console.log('✅ Boleto registrado no Santander');

            // 2. Gerar PDF
            const digitableLine = boletoResponse.digitableLine;
            const payerDocument = requestData.dadosBoleto.pagadorDocumento;
            const fileName = `boleto-${pontuacaoRef.id}.pdf`;

            if (!digitableLine) {
                throw new Error('Linha digitável não retornada');
            }

            const pdfUrlTemporario = await gerarPdfBoleto(digitableLine, payerDocument);
            console.log('✅ PDF gerado:', pdfUrlTemporario);

            // 3. Upload para Cloudinary
            const urlFinalCloudinary = await uploadPdfParaCloudinary(pdfUrlTemporario, fileName, pontuacaoRef.id);
            console.log('✅ PDF salvo no Cloudinary');

            // 4. Atualizar Firebase
            const dadosAtualizados = {
                boletoPdfUploadDate: new Date(),
                santanderResponse: boletoResponse.data || boletoResponse,
                boletoLinhaDigitavel: digitableLine,
                boletoCodigoBarras: boletoResponse.barCode || "N/A",
                boletoNsuCode: boletoResponse.nsuCode || "N/A",
                qrCodePix: boletoResponse.qrCodePix || boletoResponse.qrCode || "N/A",
                status: 'pendente'
            };

            await pontuacaoRef.update(dadosAtualizados);
            console.log('✅ Dados atualizados no Firebase');

            // 5. Download automático
            await baixarPdfAutomaticamente(pdfUrlTemporario, fileName);
            console.log('✅ Download automático realizado');

            return {
                ...(boletoResponse.data || boletoResponse),
                boletoPdfUrl: urlFinalCloudinary,
                pdfUrlTemporario: pdfUrlTemporario,
                pontuacaoId: pontuacaoRef.id,
                qrCode: dadosAtualizados.qrCodePix
            };

        } catch (error) {
            console.error('💥 Erro no processo completo:', error);
            try {
                await pontuacaoRef.update({
                    status: 'erro',
                    erroProcessamento: error.message || 'Erro desconhecido'
                });
            } catch (updateError) {
                console.error('Erro ao atualizar status:', updateError);
            }
            throw error;
        }
    }

    // --- Funções da Interface ---
    function mostrarQrCode(qrCodeData) {
        const qrCodeImageDiv = document.getElementById('qrCodeImage');
        currentQrCodeData = qrCodeData;

        if (!qrCodeImageDiv) return;

        const qrString = qrCodeData?.qrCodeString;
        const qrImage = qrCodeData?.qrCodeImage;

        if (qrImage) {
            qrCodeImageDiv.innerHTML = `<img src="${qrImage}" alt="QR Code PIX" class="mx-auto max-w-xs h-auto block">`;
        } else if (qrString && qrString !== "N/A") {
            qrCodeImageDiv.innerHTML = `
                <div class="bg-gray-100 p-3 rounded-lg border border-gray-200">
                  <p class="text-xs text-gray-600 mb-1">Código PIX (Copia e Cola):</p>
                  <p class="font-mono text-xs break-all bg-white p-2 rounded shadow-sm">${qrString}</p>
                </div>
            `;
        } else {
            qrCodeImageDiv.innerHTML = '<p class="text-center text-red-500 font-medium">QR Code PIX não disponível.</p>';
        }

        qrCodeModal?.classList.add('active');
    }

    async function copiarCodigoPix() {
        if (!currentQrCodeData || !currentQrCodeData.qrCodeString || currentQrCodeData.qrCodeString === "N/A") {
            alert('Código PIX não disponível.');
            return;
        }
        
        const textToCopy = currentQrCodeData.qrCodeString;
        try {
            await navigator.clipboard.writeText(textToCopy);
            alert('Código PIX copiado!');
        } catch (err) {
            console.error('Falha ao copiar:', err);
            // Fallback manual
            try {
                const textArea = document.createElement("textarea");
                textArea.value = textToCopy;
                textArea.style.position = "fixed";
                textArea.style.top = "-9999px";
                textArea.style.left = "-9999px";
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                alert('Código PIX copiado!');
            } catch (fallbackErr) {
                console.error('Falha ao copiar (fallback):', fallbackErr);
                alert('Não foi possível copiar automaticamente. Selecione e copie o código manualmente.');
            }
        }
    }

    function mostrarConfirmacao(dados) {
        const confirmacaoContainer = document.getElementById('confirmacao-container');
        if (!confirmacaoContainer) return;

        const profissional = profissionaisAtivos.find(p => p.id === dados.profissionalId) || {
            nome: dados.profissionalNome,
            fotoPerfilURL: null,
            cpf: null,
            tipoProfissional: null
        };
        
        const vendedor = vendedoresAtivos.find(v => v.id === dados.vendedorId) || {
            nome: dados.vendedorNome,
            fotoURL: null,
            cpf: null,
            funcao: null
        };

        const formatarCpf = (cpf) => {
            if (!cpf) return 'Não informado';
            const cpfLimpo = cpf.toString().replace(/\D/g, '').padStart(11, '0');
            return cpfLimpo.length === 11 ? cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : 'Inválido';
        };

        // Preencher dados
        const setHTML = (id, html) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = html;
        };
        
        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        setHTML('conf-profissional-img', profissional.fotoPerfilURL
            ? `<img src="${profissional.fotoPerfilURL}" alt="${profissional.nome}">`
            : '<i class="fas fa-user"></i>');
        setText('conf-profissional', profissional.nome || 'N/A');
        setText('conf-profissional-details', `${profissional.tipoProfissional || 'Profissional'} | CPF: ${formatarCpf(profissional.cpf)}`);

        setHTML('conf-vendedor-img', vendedor.fotoURL
            ? `<img src="${vendedor.fotoURL}" alt="${vendedor.nome}">`
            : '<i class="fas fa-user-tie"></i>');
        setText('conf-vendedor', vendedor.nome || 'N/A');
        setText('conf-vendedor-details', `${vendedor.funcao || 'Vendedor'} | CPF: ${formatarCpf(vendedor.cpf)}`);

        const dataCompra = dados.dataReferencia ? new Date(dados.dataReferencia + 'T00:00:00') : null;
        const vencimento = dados.vencimento instanceof Date ? dados.vencimento : (dados.vencimento ? new Date(dados.vencimento) : null);

        setText('conf-data-compra', dataCompra ? dataCompra.toLocaleDateString('pt-BR') : 'N/D');
        setText('conf-valor-compra', (dados.valorCompra || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }));
        setText('conf-pontos', (dados.pontos || 0).toLocaleString('pt-BR'));
        setText('conf-observacao', dados.observacao || 'Nenhuma');
        setText('conf-valor-boleto', (dados.valorBoleto || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }));
        setText('conf-vencimento', vencimento ? vencimento.toLocaleDateString('pt-BR') : 'N/D');

        confirmacaoContainer.style.display = 'block';
        confirmacaoContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Configurar botões
        const viewQrCodeBtnConfirm = document.getElementById('view-qrcode-confirm');
        const downloadBoletoBtnConfirm = document.getElementById('download-boleto-confirm');

        if (viewQrCodeBtnConfirm) {
            viewQrCodeBtnConfirm.onclick = () => {
                if (currentBoletoData?.qrCode && currentBoletoData.qrCode !== "N/A") {
                    mostrarQrCode({
                        qrCodeString: currentBoletoData.qrCode,
                        qrCodeImage: currentBoletoData.qrCodeImage
                    });
                } else {
                    alert('QR Code PIX não disponível.');
                }
            };
        }

        if (downloadBoletoBtnConfirm) {
            downloadBoletoBtnConfirm.onclick = () => {
                const urlParaBaixar = currentBoletoData?.boletoPdfUrl;
                if (urlParaBaixar) {
                    window.open(urlParaBaixar, '_blank');
                } else {
                    alert('URL de download não encontrada.');
                }
            };
        }
    }

    // --- Lógica do Formulário ---
    const valorCompraInput = document.getElementById('valor-compra');
    const pontuacaoInput = document.getElementById('pontuacao-input');
    
    if (valorCompraInput && pontuacaoInput) {
        valorCompraInput.addEventListener('input', function() {
            const valorTexto = this.value.replace(/\./g, '').replace(',', '.');
            const valor = parseFloat(valorTexto) || 0;
            pontuacaoInput.value = Math.floor(valor);
        });
    }

    const pontuacaoForm = document.getElementById('pontuacao-form');
    if (pontuacaoForm) {
        pontuacaoForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const submitButton = document.getElementById('submit-button');
            if (!submitButton) return;
            
            const originalText = submitButton.innerHTML;
            submitButton.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando...';
            submitButton.disabled = true;
            
            let pontuacaoRefId = null;

            try {
                // Coleta de dados
                const profissionalId = document.getElementById('profissional-id').value;
                const vendedorId = document.getElementById('vendedor-id').value;
                const dataReferencia = document.getElementById('data-referencia').value;
                const valorTexto = valorCompraInput.value.replace(/\./g, '').replace(',', '.');
                const valorCompra = parseFloat(valorTexto) || 0;
                const observacao = document.getElementById('observacao').value.trim();
                const pontos = parseInt(pontuacaoInput.value) || 0;

                // Validação
                if (!profissionalId || !vendedorId || !dataReferencia || valorCompra <= 0 || pontos <= 0) {
                    throw new Error('Preencha todos os campos obrigatórios corretamente.');
                }
                
                if (new Date(dataReferencia) > new Date()) {
                    throw new Error('A data da compra não pode ser no futuro.');
                }

                const profissional = profissionaisAtivos.find(p => p.id === profissionalId);
                const vendedor = vendedoresAtivos.find(v => v.id === vendedorId);
                
                if (!profissional) throw new Error('Profissional selecionado inválido.');
                if (!vendedor) throw new Error('Vendedor selecionado inválido.');

                // Cálculos
                const valorBoleto = pontos * 0.02;

                // Dados para backend
                const dadosBoletoParaBackend = {
                    profissionalId,
                    profissionalNome: profissional.nome,
                    vendedorId,
                    vendedorNome: vendedor.nome,
                    valor: valorBoleto,
                    pagadorNome: lojistaData.nomeFantasia || lojistaData.nome || "Lojista",
                    pagadorDocumento: lojistaData.cnpj || "00000000000000",
                    pagadorEndereco: lojistaData.endereco || "N/D",
                    bairro: lojistaData.bairro || "N/D",
                    pagadorCidade: lojistaData.cidade || "N/D",
                    pagadorEstado: lojistaData.estado || "SP",
                    pagadorCEP: lojistaData.cep || "00000000",
                    valorCompra,
                    pontos,
                    observacao,
                    dataReferencia
                };
                
                const requestData = {
                    dadosBoleto: dadosBoletoParaBackend,
                    lojistaId
                };

                console.log('📤 Iniciando processamento...');

                // Salvar rascunho no Firebase
                const dadosFirebase = {
                    lojistaId,
                    lojistaNome: lojistaData.nomeFantasia || lojistaData.nome,
                    profissionalId,
                    profissionalNome: profissional.nome,
                    vendedorId,
                    vendedorNome: vendedor.nome,
                    dataReferencia: firebase.firestore.Timestamp.fromDate(new Date(dataReferencia + 'T00:00:00')),
                    observacao: observacao || "",
                    valorCompra,
                    pontos,
                    status: 'processando',
                    data: firebase.firestore.FieldValue.serverTimestamp(),
                    dataPagamento: null,
                    boletoValor: parseFloat(valorBoleto.toFixed(2))
                };
                
                const pontuacaoRef = await db.collection('pontuacoes').add(dadosFirebase);
                pontuacaoRefId = pontuacaoRef.id;
                console.log('✅ Rascunho salvo com ID:', pontuacaoRefId);

                // Processar boleto completo
                const boletoResponseCompleto = await processarBoletoCompleto(requestData, pontuacaoRef);
                currentBoletoData = boletoResponseCompleto;
                console.log('✅ Processo completo concluído');

                // Salvar na subcoleção do profissional
                const dadosProfissional = {
                    lojistaId,
                    lojistaNome: lojistaData.nomeFantasia || lojistaData.nome,
                    profissionalId,
                    profissionalNome: profissional.nome,
                    vendedorId,
                    vendedorNome: vendedor.nome,
                    dataReferencia: dadosFirebase.dataReferencia,
                    observacao: observacao || "",
                    valorCompra,
                    pontos,
                    status: 'pendente',
                    data: dadosFirebase.data,
                    dataPagamento: null,
                    boletoId: boletoResponseCompleto.nsuCode || "N/A",
                    boletoValor: parseFloat(valorBoleto.toFixed(2)),
                    boletoVencimento: boletoResponseCompleto.dueDate ?
                        firebase.firestore.Timestamp.fromDate(new Date(boletoResponseCompleto.dueDate + 'T00:00:00')) : null,
                    qrCodePix: boletoResponseCompleto.qrCode || "N/A",
                    pontuacaoId: pontuacaoRefId,
                    boletoPdfUrl: boletoResponseCompleto.boletoPdfUrl
                };
                
                await db.collection('profissionais').doc(profissionalId).collection('pontuacoes').add(dadosProfissional);
                console.log('✅ Dados salvos na subcoleção');

                // Mostrar confirmação
                mostrarConfirmacao({
                    profissionalId,
                    vendedorId,
                    dataReferencia,
                    valorCompra,
                    pontos,
                    observacao,
                    valorBoleto: parseFloat(valorBoleto.toFixed(2)),
                    vencimento: boletoResponseCompleto.dueDate ?
                        new Date(boletoResponseCompleto.dueDate + 'T00:00:00') : null
                });

                // Limpar formulário
                pontuacaoForm.reset();
                if(dataReferenciaInput) dataReferenciaInput.valueAsDate = new Date();
                document.getElementById('profissional-select-trigger').querySelector('span').textContent = 'Selecione profissional';
                document.getElementById('vendedor-select-trigger').querySelector('span').textContent = 'Selecione vendedor';
                document.getElementById('profissional-id').value = '';
                document.getElementById('vendedor-id').value = '';
                
                if (typeof $ !== 'undefined') {
                    $(valorCompraInput).trigger('input');
                }

                await carregarHistoricoPontuacoes();
                console.log('🎉 Processo concluído com sucesso!');

            } catch (error) {
                console.error('💥 Erro na submissão:', error);
                alert('Falha ao processar pontuação: ' + error.message);
                
                if (pontuacaoRefId) {
                    try {
                        await db.collection('pontuacoes').doc(pontuacaoRefId).update({
                            status: 'erro',
                            erroProcessamento: error.message || 'Erro desconhecido'
                        });
                        await carregarHistoricoPontuacoes();
                    } catch (updateError) {
                        console.error('Falha ao atualizar status:', updateError);
                    }
                }
            } finally {
                submitButton.innerHTML = originalText;
                submitButton.disabled = false;
            }
        });
    }

    // --- Botões Pós-Confirmação ---
    const novaPontuacaoBtn = document.getElementById('nova-pontuacao');
    const verHistoricoBtn = document.getElementById('ver-historico');
    const confirmacaoContainer = document.getElementById('confirmacao-container');
    const historicoPontuacoesDiv = document.getElementById('historico-pontuacoes');

    if (novaPontuacaoBtn && confirmacaoContainer && pontuacaoForm) {
        novaPontuacaoBtn.addEventListener('click', () => {
            confirmacaoContainer.style.display = 'none';
            pontuacaoForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    
    if (verHistoricoBtn && historicoPontuacoesDiv) {
        verHistoricoBtn.addEventListener('click', () => {
            historicoPontuacoesDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // --- Função de Carregar Histórico (placeholder) ---
    async function carregarHistoricoPontuacoes() {
        // Implementação do carregamento do histórico
        console.log('Carregando histórico de pontuações...');
        // Sua implementação aqui
    }

    // --- Função de Debug ---
    const debugBtn = document.getElementById('debug-btn');
    if (debugBtn) {
        debugBtn.addEventListener('click', debugFirebaseData);
    }
    
    async function debugFirebaseData() {
        try {
            console.log('🐛 DEBUG: Verificando dados no Firebase...');
            if (!lojistaId) {
                console.log("Lojista ID ainda não carregado.");
                return;
            }

            const pontuacoesSnapshot = await db.collection('pontuacoes')
                .where('lojistaId', '==', lojistaId)
                .orderBy('data', 'desc')
                .limit(5)
                .get();
            
            console.log(`📊 Últimas ${pontuacoesSnapshot.size} pontuações:`);
            pontuacoesSnapshot.forEach(doc => console.log(`📋 ${doc.id}:`, doc.data()));

            console.log(`👥 ${profissionaisAtivos.length} profissionais:`, profissionaisAtivos.map(p => ({id: p.id, nome: p.nome})));
            console.log(`👨‍💼 ${vendedoresAtivos.length} vendedores:`, vendedoresAtivos.map(v => ({id: v.id, nome: v.nome})));

            console.log("🔄 Recarregando histórico...");
            await carregarHistoricoPontuacoes();
            console.log("✅ Histórico recarregado.");

        } catch (error) {
            console.error('❌ Erro no debug:', error);
        }
    }

   }); // Fim do DOMContentLoaded
 </script>
