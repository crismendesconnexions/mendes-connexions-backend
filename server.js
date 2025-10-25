<script>
   document.addEventListener('DOMContentLoaded', function() {
     // URL da API backend
     const API_BASE_URL = 'https://mendes-connexions-backend.onrender.com';

     // Variável para armazenar dados do lojista
     let lojistaData = {};
     let lojistaId = '';
     let profissionaisAtivos = [];
     let vendedoresAtivos = [];
     let currentBoletoData = null; // Guarda dados do último boleto gerado com sucesso
     let currentQrCodeData = null; // Guarda dados do QR Code para cópia

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
             window.location.href = 'dashboard.html'; // Redireciona para página de login/dashboard
           }).catch(function(error) {
             console.error('Erro ao fazer logout:', error);
             alert('Erro ao sair. Tente novamente.');
           });
         }
       });
     } else {
       console.warn('Botão de logout não encontrado na inicialização');
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
     qrCodeModal.addEventListener('click', function(e) { // Fechar ao clicar fora
       if (e.target === qrCodeModal) {
         qrCodeModal.classList.remove('active');
       }
     });

     // --- Teste Inicial de Conexão com Backend ---
     console.log('=== INICIANDO VERIFICAÇÃO DE CONEXÃO ===');
     console.log('URL do Backend:', API_BASE_URL);
     fetch(`${API_BASE_URL}/health`)
       .then(response => {
         console.log('Health Check Status:', response.status);
         if (!response.ok) throw new Error(`HTTP ${response.status}`);
         return response.json();
       })
       .then(data => console.log('Health Check Response:', data))
       .catch(error => console.error('Erro no Health Check básico:', error));

     // --- Lógica do Menu Mobile ---
     if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
            sidebar.classList.toggle('active');
        });
        document.addEventListener('click', (e) => { // Fechar ao clicar fora
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
         console.warn("jQuery Mask não carregado ou falhou:", e);
     }
     const dataReferenciaInput = document.getElementById('data-referencia');
     if (dataReferenciaInput) {
        dataReferenciaInput.valueAsDate = new Date(); // Define data atual
     }


     // --- Status de Integração Inicial ---
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
                    // Fecha o outro select se estiver aberto
                    const outroTipo = tipo === 'profissional' ? 'vendedor' : 'profissional';
                    document.getElementById(`${outroTipo}-select-options`)?.classList.remove('active');
                    // Abre/fecha o select atual
                    options.classList.toggle('active');
                    if (options.classList.contains('active')) {
                        search.focus();
                        search.value = ''; // Limpa busca ao abrir
                        // Força a re-renderização inicial (caso a busca anterior tenha filtrado)
                        const event = new Event('input', { bubbles: true, cancelable: true });
                        search.dispatchEvent(event);
                    }
                });
                options.addEventListener('click', (e) => e.stopPropagation()); // Impede fechar ao clicar dentro
            }
        });
         // Fechar selects ao clicar fora
        document.addEventListener('click', (e) => {
            document.getElementById('profissional-select-options')?.classList.remove('active');
            document.getElementById('vendedor-select-options')?.classList.remove('active');
        });
     }

     // --- Verificação de Autenticação e Carga Inicial ---
     auth.onAuthStateChanged(async function(user) {
       if (user) {
         lojistaId = user.uid;
         console.log('Usuário autenticado:', lojistaId);
         try {
             await Promise.all([
                 carregarDadosLojista(lojistaId),
                 carregarProfissionaisAtivos(), // Carrega primeiro para usar no histórico
                 carregarVendedoresAtivos()     // Carrega primeiro para usar no histórico
             ]);
             await carregarHistoricoPontuacoes(); // Carrega histórico DEPOIS de ter prof/vend
             configurarSelectPersonalizado();
             await testarConexaoBackend(); // Testa conexão após carregar dados
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
         window.location.href = 'dashboard.html'; // Redireciona para login
       }
     });

     // --- Funções de Carga de Dados (Lojista, Profissionais, Vendedores) ---
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
           // Tratar caso: talvez deslogar ou mostrar mensagem
         }
       } catch (error) {
         console.error('Erro ao carregar dados do lojista:', error);
         // Mostrar mensagem de erro para o usuário
       }
     }

      async function carregarProfissionaisAtivos() {
        try {
            const snapshot = await db.collection('profissionais')
                                    .where('status', '==', 'aprovado') // Apenas aprovados
                                    .orderBy('nome') // Ordenar por nome
                                    .get();
            profissionaisAtivos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            console.log(`Carregados ${profissionaisAtivos.length} profissionais ativos.`);
            const optionsContainer = document.getElementById('profissional-options-list');
            if (optionsContainer) {
                optionsContainer.innerHTML = ''; // Limpa antes de adicionar
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
         if (!lojistaId) return; // Precisa do ID do lojista
         try {
             const snapshot = await db.collection('vendedores')
                                     .where('lojistaId', '==', lojistaId)
                                     .orderBy('nome') // Ordenar por nome
                                     .get();
             vendedoresAtivos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
             console.log(`Carregados ${vendedoresAtivos.length} vendedores para o lojista ${lojistaId}.`);
             const optionsContainer = document.getElementById('vendedor-options-list');
             if (optionsContainer) {
                 optionsContainer.innerHTML = ''; // Limpa antes de adicionar
                 if (vendedoresAtivos.length === 0) {
                     optionsContainer.innerHTML = '<div class="select-option text-gray-500">Nenhum vendedor cadastrado</div>';
                 } else {
                     vendedoresAtivos.forEach(v => optionsContainer.appendChild(criarOpcaoSelectPersonalizado(v, 'vendedor')));
                 }
                 configurarBuscaSelectPersonalizado('search-vendedor', 'vendedor-options-list', vendedoresAtivos, 'vendedor');
             }
         } catch (error) {
             console.error(`Erro ao carregar vendedores do lojista ${lojistaId}:`, error);
              const optionsContainer = document.getElementById('vendedor-options-list');
             if(optionsContainer) optionsContainer.innerHTML = '<div class="select-option text-red-500">Erro ao carregar</div>';
         }
     }


     // --- Funções Auxiliares (Criar Opção, Configurar Busca) ---
     function criarOpcaoSelectPersonalizado(item, tipo) {
       const div = document.createElement('div');
       div.className = 'select-option';
       div.setAttribute('data-id', item.id);
       div.setAttribute('data-nome', item.nome); // Guarda nome para fácil acesso

       let imagemHTML = '';
       let detalhes = '';
       let cpfFormatado = 'Não informado';

       if (item.cpf) {
           const cpfLimpo = item.cpf.toString().replace(/\D/g, '').padStart(11, '0');
            if (cpfLimpo.length === 11) {
              cpfFormatado = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
            } else {
              cpfFormatado = "Inválido"; // Ou apenas o número como estava
            }
       }


       if (tipo === 'profissional') {
         imagemHTML = item.fotoPerfilURL
           ? `<img src="${item.fotoPerfilURL}" class="select-option-image" alt="${item.nome}" onerror="this.onerror=null; this.replaceWith(document.createTextNode('🖼️'))">` // Fallback se imagem quebrar
           : `<div class="select-option-image"><i class="fas fa-user"></i></div>`;
         detalhes = `${item.tipoProfissional || 'Profissional'} | CPF: ${cpfFormatado}`;
       } else if (tipo === 'vendedor') {
         imagemHTML = item.fotoURL
           ? `<img src="${item.fotoURL}" class="select-option-image" alt="${item.nome}" onerror="this.onerror=null; this.replaceWith(document.createTextNode('🖼️'))">` // Fallback
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
            optionsList.innerHTML = ''; // Limpa a lista

            const filteredItems = items.filter(item => {
                const nome = item.nome?.toLowerCase() || '';
                const cpf = item.cpf?.replace(/\D/g, '') || ''; // Busca por CPF sem formatação
                const tipoProf = tipo === 'profissional' ? (item.tipoProfissional?.toLowerCase() || '') : '';
                const funcaoVend = tipo === 'vendedor' ? (item.funcao?.toLowerCase() || '') : '';

                return nome.includes(searchTerm) ||
                       cpf.includes(searchTerm) || // Busca no CPF limpo
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


     // --- Funções Principais de Negócio (Registrar, Gerar PDF, Upload, Processar Completo) ---

     async function registrarBoletoSantander(requestData) {
       // (Esta função não mudou, continua chamando o backend)
       try {
         const user = auth.currentUser;
         if (!user) throw new Error('Usuário não autenticado para registrar boleto');
         const token = await user.getIdToken();
         console.log('📤 Enviando dados para registro de boleto:', requestData);
         const response = await fetch(`${API_BASE_URL}/api/santander/boletos`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
           body: JSON.stringify(requestData)
         });
         console.log('📥 Status do registro:', response.status);
         const responseData = await response.json(); // Tenta parsear JSON mesmo em erro
         if (!response.ok) {
           console.error('❌ Erro da API Santander (registro):', responseData);
           throw new Error(responseData.details || responseData.error || `Erro ${response.status}`);
         }
         console.log('✅ Boleto registrado com sucesso:', responseData);
         return responseData;
       } catch (error) {
         console.error('💥 Erro completo ao registrar boleto:', error);
         throw error; // Re-lança para o handler principal
       }
     }

      async function gerarPdfBoleto(digitableLine, payerDocumentNumber) {
        // (Esta função não mudou, continua chamando o backend)
        try {
            const user = auth.currentUser;
            if (!user) throw new Error('Usuário não autenticado para gerar PDF');
            const token = await user.getIdToken();
            console.log('📄 Solicitando link PDF do boleto:', { digitableLine, payerDocumentNumber });
            const response = await fetch(`${API_BASE_URL}/api/santander/boletos/pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    digitableLine: digitableLine,
                    payerDocumentNumber: payerDocumentNumber // Backend limpa se necessário
                })
            });
            console.log('📥 Status da resposta PDF:', response.status);
            const responseData = await response.json(); // Tenta parsear mesmo em erro
            if (!response.ok) {
                console.error('❌ Erro da API Santander (PDF):', responseData);
                throw new Error(responseData.details || responseData.error || `Erro ${response.status}`);
            }
            if (!responseData.link) {
                console.error("Link do PDF não retornado:", responseData);
                throw new Error('Link do PDF não retornado pelo servidor');
            }
            console.log('✅ Link PDF gerado:', responseData.link);
            return responseData.link; // Retorna apenas o link temporário
        } catch (error) {
            console.error('💥 Erro ao gerar link PDF do boleto:', error);
            throw error; // Re-lança
        }
    }

      // ✅ CORREÇÃO: Função uploadPdfParaCloudinary SIMPLIFICADA
      // Pega a URL do backend e salva diretamente no Firebase.
      async function uploadPdfParaCloudinary(pdfUrl, fileName, pontuacaoId) {
          return new Promise(async (resolve, reject) => {
            try {
              console.log('☁️ Iniciando upload para Cloudinary via backend:', fileName);

              const user = auth.currentUser;
              if (!user) throw new Error('Usuário não autenticado para upload');
              const token = await user.getIdToken();

              const response = await fetch(`${API_BASE_URL}/api/cloudinary/upload-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ pdfUrl, fileName, pontuacaoId })
              });

              const result = await response.json(); // Tenta parsear mesmo em erro

              if (!response.ok) {
                console.error("Erro no upload via backend:", result);
                throw new Error(result.details || result.error || `Erro ${response.status} no upload`);
              }

              console.log('✅ Upload via backend realizado:', result);

              // --- INÍCIO DA CORREÇÃO: Salvar a URL EXATA do Backend ---

              // 1. Pegar a URL EXATA que o backend retornou (a que você viu no log, /image/upload/...)
              const backendUrl = result.cloudinaryUrl;
              const publicId = result.publicId; // Pegar o publicId também

              if (!backendUrl) {
                  throw new Error("Backend não retornou a cloudinaryUrl após upload.");
              }

              console.log("🔗 URL Recebida do Backend (será salva):", backendUrl);

              // 2. ATUALIZAR O FIREBASE salvando essa URL diretamente nos campos principais
              await db.collection('pontuacoes').doc(pontuacaoId).update({
                boletoPdfUrl: backendUrl,      // Salva a URL do backend aqui
                boletoDownloadUrl: backendUrl, // Salva a mesma URL aqui (botão do histórico usa este)
                boletoViewUrl: backendUrl,     // Salva aqui também por consistência
                boletoPublicId: publicId       // Salva o publicId retornado pelo backend
              });

              console.log('✅ URL do backend salva diretamente no Firebase');
              resolve(backendUrl); // Retorna a URL do backend para uso imediato

              // --- FIM DA CORREÇÃO ---

            } catch (error) {
              console.error('❌ Erro na função uploadPdfParaCloudinary:', error);
              reject(error); // Re-lança para o handler principal
            }
          });
        }


      async function processarBoletoCompleto(requestData, pontuacaoRef) {
        try {
          console.log('🔄 Iniciando processo completo do boleto...');

          // 1. Registrar boleto no Santander
          const boletoResponse = await registrarBoletoSantander(requestData);
          console.log('✅ Boleto registrado no Santander');

          // 2. Gerar PDF do boleto (obter link temporário)
          const digitableLine = boletoResponse.digitableLine;
          const payerDocument = requestData.dadosBoleto.pagadorDocumento;
          const fileName = `boleto-${pontuacaoRef.id}.pdf`; // Nome mais consistente

          if (!digitableLine) {
              throw new Error('Linha digitável não retornada pelo Santander no registro.');
          }

          const pdfUrlTemporario = await gerarPdfBoleto(digitableLine, payerDocument);
          console.log('✅ Link temporário do PDF gerado:', pdfUrlTemporario);

          // 3. Fazer upload do PDF para Cloudinary (via backend)
          // Esta função AGORA salva a URL final (backendUrl) nos campos corretos do Firebase
          const urlFinalCloudinary = await uploadPdfParaCloudinary(pdfUrlTemporario, fileName, pontuacaoRef.id);
          console.log('✅ PDF salvo no Cloudinary, URL final:', urlFinalCloudinary);

          // 4. Atualizar dados NO Firebase com informações adicionais do Santander
          // (a URL já foi salva corretamente pela função de upload)
          const dadosAtualizados = {
            // boletoPdfUrl e boletoDownloadUrl JÁ FORAM SALVOS pela uploadPdfParaCloudinary
            boletoPdfUploadDate: new Date(),
            santanderResponse: boletoResponse.data || boletoResponse, // Garante salvar a resposta completa
            boletoLinhaDigitavel: digitableLine,
            boletoCodigoBarras: boletoResponse.barCode || "N/A",
            boletoNsuCode: boletoResponse.nsuCode || "N/A", // Vem direto da resposta
            qrCodePix: boletoResponse.qrCodePix || boletoResponse.qrCode || "N/A",
            status: 'pendente' // Define o status final como pendente
          };

          await pontuacaoRef.update(dadosAtualizados);
          console.log('✅ Dados adicionais do Santander atualizados no Firebase');

          // 5. Baixar PDF automaticamente para o usuário (usando o link temporário do Santander)
          // Isso garante que o usuário tenha o boleto imediatamente
          await baixarPdfAutomaticamente(pdfUrlTemporario, fileName);
          console.log('✅ Download automático (via link temp) realizado');

          // Retornar dados completos, incluindo a URL final do Cloudinary
          return {
            ...(boletoResponse.data || boletoResponse), // Usa a resposta completa do Santander
            boletoPdfUrl: urlFinalCloudinary, // URL final do Cloudinary
            pdfUrlTemporario: pdfUrlTemporario, // Link temporário (para referência)
            pontuacaoId: pontuacaoRef.id,
            qrCode: dadosAtualizados.qrCodePix // Garante que o QR Code correto seja retornado
          };

        } catch (error) {
          console.error('💥 Erro no processo completo do boleto:', error);
          // Tenta atualizar o status no Firebase para 'erro'
          try {
              await pontuacaoRef.update({
                  status: 'erro',
                  erroProcessamento: error.message || 'Erro desconhecido no processo completo'
              });
          } catch (updateError) {
              console.error('Erro ao tentar atualizar status para erro:', updateError);
          }
          throw error; // Re-lança o erro
        }
      }


     // --- Funções da Interface (Mostrar QR Code, Copiar PIX, Mostrar Confirmação) ---
      function mostrarQrCode(qrCodeData) {
        const qrCodeImageDiv = document.getElementById('qrCodeImage');
        currentQrCodeData = qrCodeData; // Armazena para cópia

        if (!qrCodeImageDiv) return;

        const qrString = qrCodeData?.qrCodeString;
        const qrImage = qrCodeData?.qrCodeImage; // Pode ser uma URL base64 ou externa

        if (qrImage) {
            qrCodeImageDiv.innerHTML = `<img src="${qrImage}" alt="QR Code PIX" class="mx-auto max-w-xs h-auto block">`;
        } else if (qrString && qrString !== "N/A") {
             // Tentar gerar QR Code localmente (requer biblioteca como qrcode.js)
             // Se não tiver a biblioteca, mostrar apenas o texto
             qrCodeImageDiv.innerHTML = `
                <div class="bg-gray-100 p-3 rounded-lg border border-gray-200">
                  <p class="text-xs text-gray-600 mb-1">Código PIX (Copia e Cola):</p>
                  <p class="font-mono text-xs break-all bg-white p-2 rounded shadow-sm">${qrString}</p>
                </div>
              `;
             // Para gerar imagem:
             // 1. Inclua <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script> no <head>
             // 2. Use o código abaixo:
             /*
             qrCodeImageDiv.innerHTML = ''; // Limpa
             try {
                new QRCode(qrCodeImageDiv, {
                    text: qrString,
                    width: 200,
                    height: 200,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
             } catch(e) {
                 console.error("Erro ao gerar QR Code:", e);
                 qrCodeImageDiv.innerHTML = '<p class="text-red-500">Erro ao gerar imagem QR Code.</p>';
             }
             */
        } else {
          qrCodeImageDiv.innerHTML = '<p class="text-center text-red-500 font-medium">QR Code PIX não disponível.</p>';
        }

        qrCodeModal?.classList.add('active');
      }

      async function copiarCodigoPix() {
        if (!currentQrCodeData || !currentQrCodeData.qrCodeString || currentQrCodeData.qrCodeString === "N/A") {
          alert('Código PIX Copia e Cola não disponível.');
          return;
        }
        const textToCopy = currentQrCodeData.qrCodeString;
        try {
          await navigator.clipboard.writeText(textToCopy);
          alert('Código PIX copiado!');
        } catch (err) {
          console.error('Falha ao copiar (navigator.clipboard):', err);
          // Fallback manual
          try {
              const textArea = document.createElement("textarea");
              textArea.value = textToCopy;
              textArea.style.position = "fixed"; textArea.style.top = "-9999px"; textArea.style.left = "-9999px";
              document.body.appendChild(textArea);
              textArea.select();
              document.execCommand('copy');
              document.body.removeChild(textArea);
              alert('Código PIX copiado (fallback)!');
          } catch (fallbackErr) {
              console.error('Falha ao copiar (fallback):', fallbackErr);
              alert('Não foi possível copiar automaticamente. Selecione e copie o código manualmente.');
              // Opcional: Selecionar o texto no modal para facilitar
              const codeElement = qrCodeModal?.querySelector('.font-mono');
              if (codeElement) {
                  const range = document.createRange();
                  range.selectNodeContents(codeElement);
                  const selection = window.getSelection();
                  selection.removeAllRanges();
                  selection.addRange(range);
              }
          }
        }
      }

    function mostrarConfirmacao(dados) {
        const confirmacaoContainer = document.getElementById('confirmacao-container');
        if (!confirmacaoContainer) return;

        // Buscar dados mais recentes (garante nome/foto atualizados)
        const profissional = profissionaisAtivos.find(p => p.id === dados.profissionalId) || { nome: dados.profissionalNome, fotoPerfilURL: null, cpf: null, tipoProfissional: null };
        const vendedor = vendedoresAtivos.find(v => v.id === dados.vendedorId) || { nome: dados.vendedorNome, fotoURL: null, cpf: null, funcao: null };

        // Formatar CPFs
        const formatarCpf = (cpf) => {
            if (!cpf) return 'Não informado';
            const cpfLimpo = cpf.toString().replace(/\D/g, '').padStart(11, '0');
            return cpfLimpo.length === 11 ? cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : 'Inválido';
        };

        // Preencher detalhes
        const setHTML = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

        setHTML('conf-profissional-img', profissional.fotoPerfilURL
            ? `<img src="${profissional.fotoPerfilURL}" alt="${profissional.nome || ''}">`
            : '<i class="fas fa-user"></i>');
        setText('conf-profissional', profissional.nome || 'Profissional não encontrado');
        setText('conf-profissional-details', `${profissional.tipoProfissional || 'Profissional'} | CPF: ${formatarCpf(profissional.cpf)}`);

        setHTML('conf-vendedor-img', vendedor.fotoURL
            ? `<img src="${vendedor.fotoURL}" alt="${vendedor.nome || ''}">`
            : '<i class="fas fa-user-tie"></i>');
        setText('conf-vendedor', vendedor.nome || 'Vendedor não encontrado');
        setText('conf-vendedor-details', `${vendedor.funcao || 'Vendedor'} | CPF: ${formatarCpf(vendedor.cpf)}`);

        // Datas precisam ser tratadas corretamente
        const dataCompra = dados.dataReferencia ? new Date(dados.dataReferencia + 'T00:00:00') : null; // Assume YYYY-MM-DD
        const vencimento = dados.vencimento instanceof Date ? dados.vencimento : (dados.vencimento ? new Date(dados.vencimento) : null);

        setText('conf-data-compra', dataCompra ? dataCompra.toLocaleDateString('pt-BR') : 'N/D');
        setText('conf-valor-compra', (dados.valorCompra || 0).toFixed(2).replace('.', ','));
        setText('conf-pontos', dados.pontos || 0);
        setText('conf-observacao', dados.observacao || 'Nenhuma');
        setText('conf-valor-boleto', (dados.valorBoleto || 0).toFixed(2).replace('.', ','));
        setText('conf-vencimento', vencimento ? vencimento.toLocaleDateString('pt-BR') : 'N/D');

        confirmacaoContainer.style.display = 'block';
        confirmacaoContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Configurar botões da confirmação
        const viewQrCodeBtnConfirm = document.getElementById('view-qrcode-confirm');
        const downloadBoletoBtnConfirm = document.getElementById('download-boleto-confirm');

        if (viewQrCodeBtnConfirm) {
            viewQrCodeBtnConfirm.onclick = () => {
                if (currentBoletoData?.qrCode && currentBoletoData.qrCode !== "N/A") {
                    mostrarQrCode({ qrCodeString: currentBoletoData.qrCode, qrCodeImage: currentBoletoData.qrCodeImage });
                } else {
                    alert('QR Code PIX não disponível para este boleto.');
                }
            };
        }

        if (downloadBoletoBtnConfirm) {
            downloadBoletoBtnConfirm.onclick = () => {
                const urlParaBaixar = currentBoletoData?.boletoPdfUrl; // Usa a URL final salva
                if (urlParaBaixar) {
                    console.log('🚀 Iniciando download direto (confirmação) para:', urlParaBaixar);
                    window.open(urlParaBaixar, '_blank');
                    downloadBoletoBtnConfirm.disabled = true; // Desabilita temporariamente
                    setTimeout(() => { downloadBoletoBtnConfirm.disabled = false; }, 1500);
                } else {
                    alert('Erro: URL de download não encontrada para o boleto atual.');
                    console.error('Download (confirmação) falhou: currentBoletoData.boletoPdfUrl indisponível.');
                }
            };
        }
    }


     // --- Lógica do Formulário ---
     // Calcular pontuação automaticamente
      const valorCompraInput = document.getElementById('valor-compra');
      const pontuacaoInput = document.getElementById('pontuacao-input');
      if (valorCompraInput && pontuacaoInput) {
        valorCompraInput.addEventListener('input', function() {
          const valorTexto = this.value.replace(/\./g, '').replace(',', '.');
          const valor = parseFloat(valorTexto) || 0;
          pontuacaoInput.value = Math.floor(valor); // 1 ponto por real
        });
      }

      // Submissão do Formulário
      const pontuacaoForm = document.getElementById('pontuacao-form');
      if (pontuacaoForm) {
        pontuacaoForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          const submitButton = document.getElementById('submit-button');
          if (!submitButton) return;
          const originalText = submitButton.innerHTML;
          submitButton.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processando...';
          submitButton.disabled = true;
          let pontuacaoRefId = null; // Para referência em caso de erro

          try {
            // Coleta e Validação
            const profissionalId = document.getElementById('profissional-id').value;
            const vendedorId = document.getElementById('vendedor-id').value;
            const dataReferencia = document.getElementById('data-referencia').value; // YYYY-MM-DD
            const valorTexto = valorCompraInput.value.replace(/\./g, '').replace(',', '.');
            const valorCompra = parseFloat(valorTexto) || 0;
            const observacao = document.getElementById('observacao').value.trim();
            const pontos = parseInt(pontuacaoInput.value) || 0;

            if (!profissionalId || !vendedorId || !dataReferencia || valorCompra <= 0 || pontos <= 0) {
              throw new Error('Preencha Profissional, Vendedor, Data e Valor (maior que zero) corretamente.');
            }
            if (new Date(dataReferencia) > new Date()) {
                throw new Error('A Data da Compra não pode ser no futuro.');
            }

            const profissional = profissionaisAtivos.find(p => p.id === profissionalId);
            const vendedor = vendedoresAtivos.find(v => v.id === vendedorId);
            if (!profissional) throw new Error('Profissional selecionado inválido.');
            if (!vendedor) throw new Error('Vendedor selecionado inválido.');

            // Cálculo do Boleto
            const valorBoleto = pontos * 0.02; // Taxa de 2% sobre os pontos

             // Dados para Backend
             const dadosBoletoParaBackend = {
                profissionalId, profissionalNome: profissional.nome,
                vendedorId, vendedorNome: vendedor.nome,
                valor: valorBoleto,
                pagadorNome: lojistaData.nomeFantasia || lojistaData.nome || "Lojista N/D",
                pagadorDocumento: lojistaData.cnpj || "00000000000000",
                pagadorEndereco: lojistaData.endereco || "N/D", bairro: lojistaData.bairro || "N/D",
                pagadorCidade: lojistaData.cidade || "N/D", pagadorEstado: lojistaData.estado || "SP",
                pagadorCEP: lojistaData.cep || "00000000",
                valorCompra, pontos, observacao, dataReferencia
             };
             const requestData = { dadosBoleto: dadosBoletoParaBackend, lojistaId };

            console.log('📤 Enviando dados para processar boleto completo...');

            // Salvar Rascunho no Firebase
            const dadosFirebase = {
              lojistaId, lojistaNome: lojistaData.nomeFantasia || lojistaData.nome,
              profissionalId, profissionalNome: profissional.nome,
              vendedorId, vendedorNome: vendedor.nome,
              dataReferencia: firebase.firestore.Timestamp.fromDate(new Date(dataReferencia + 'T00:00:00')), // Salva como Timestamp
              observacao: observacao || "", valorCompra, pontos,
              status: 'processando', // Estado inicial
              data: firebase.firestore.FieldValue.serverTimestamp(), // Data de criação
              dataPagamento: null,
              boletoValor: parseFloat(valorBoleto.toFixed(2))
            };
            const pontuacaoRef = await db.collection('pontuacoes').add(dadosFirebase);
            pontuacaoRefId = pontuacaoRef.id; // Guarda ID para possível rollback ou log
            console.log('✅ Rascunho da Pontuação salva com ID:', pontuacaoRefId);

            // Processar Boleto Completo (Santander + Cloudinary + Atualizar Firebase)
            const boletoResponseCompleto = await processarBoletoCompleto(requestData, pontuacaoRef);
            currentBoletoData = boletoResponseCompleto; // Guarda dados do boleto atual
            console.log('✅ Processo completo do boleto concluído no frontend:', boletoResponseCompleto);

            // Salvar na Subcoleção do Profissional (APÓS SUCESSO)
             const dadosProfissional = {
                lojistaId, lojistaNome: lojistaData.nomeFantasia || lojistaData.nome,
                profissionalId, profissionalNome: profissional.nome,
                vendedorId, vendedorNome: vendedor.nome,
                dataReferencia: dadosFirebase.dataReferencia, // Usa o mesmo Timestamp
                observacao: observacao || "", valorCompra, pontos,
                status: 'pendente', // Status final após sucesso
                data: dadosFirebase.data, // Usa o mesmo Timestamp de criação
                dataPagamento: null,
                boletoId: boletoResponseCompleto.nsuCode || "N/A", // NSU code do Santander
                boletoValor: parseFloat(valorBoleto.toFixed(2)),
                boletoVencimento: boletoResponseCompleto.dueDate ? firebase.firestore.Timestamp.fromDate(new Date(boletoResponseCompleto.dueDate + 'T00:00:00')) : null,
                qrCodePix: boletoResponseCompleto.qrCode || "N/A",
                pontuacaoId: pontuacaoRefId, // Referência ao doc principal
                boletoPdfUrl: boletoResponseCompleto.boletoPdfUrl // URL final do Cloudinary
            };
            await db.collection('profissionais').doc(profissionalId).collection('pontuacoes').add(dadosProfissional);
            console.log('✅ Dados salvos na subcoleção do profissional');

            // Mostrar Confirmação
            mostrarConfirmacao({
                profissionalId, vendedorId, dataReferencia, valorCompra, pontos, observacao,
                valorBoleto: parseFloat(valorBoleto.toFixed(2)),
                vencimento: boletoResponseCompleto.dueDate ? new Date(boletoResponseCompleto.dueDate + 'T00:00:00') : null
            });

            // Limpar Formulário e Recarregar Histórico
            pontuacaoForm.reset();
            if(dataReferenciaInput) dataReferenciaInput.valueAsDate = new Date(); // Resetar data
            document.getElementById('profissional-select-trigger').querySelector('span').textContent = 'Selecione profissional';
            document.getElementById('vendedor-select-trigger').querySelector('span').textContent = 'Selecione vendedor';
            document.getElementById('profissional-id').value = '';
            document.getElementById('vendedor-id').value = '';
            $(valorCompraInput).trigger('input'); // Resetar pontos usando jQuery

            await carregarHistoricoPontuacoes();
            console.log('🎉 Processo de pontuação concluído com sucesso!');

          } catch (error) {
            console.error('💥 Erro GERAL na submissão do formulário:', error);
            alert('Falha ao processar pontuação: ' + error.message);
            // Tentar marcar como erro no Firebase se o doc foi criado
            if (pontuacaoRefId) {
                try {
                    await db.collection('pontuacoes').doc(pontuacaoRefId).update({
                        status: 'erro',
                        erroProcessamento: error.message || 'Erro desconhecido na submissão'
                    });
                     // Recarrega histórico para mostrar o item com status 'erro'
                     await carregarHistoricoPontuacoes();
                } catch (updateError) {
                    console.error(`Falha ao atualizar status para erro no doc ${pontuacaoRefId}:`, updateError);
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

       // --- Botão de Debug ---
       const debugBtn = document.getElementById('debug-btn');
       if (debugBtn) {
           debugBtn.addEventListener('click', debugFirebaseData);
       }
       async function debugFirebaseData() { /* ... (função debug como estava) ... */
            try {
              console.log('🐛 DEBUG: Verificando dados no Firebase...');
              if (!lojistaId) { console.log("Lojista ID ainda não carregado."); return; }

              // Verificar pontuações recentes do lojista
              const pontuacoesSnapshot = await db.collection('pontuacoes')
                .where('lojistaId', '==', lojistaId)
                .orderBy('data', 'desc')
                .limit(5)
                .get();
              console.log(`📊 Últimas ${pontuacoesSnapshot.size} pontuações encontradas:`);
              pontuacoesSnapshot.forEach(doc => console.log(`📋 Pontuação ${doc.id}:`, doc.data()));

              // Verificar profissionais e vendedores carregados
              console.log(`👥 ${profissionaisAtivos.length} profissionais na memória:`, profissionaisAtivos.map(p=>({id: p.id, nome: p.nome})));
              console.log(`👨‍💼 ${vendedoresAtivos.length} vendedores na memória:`, vendedoresAtivos.map(v=>({id: v.id, nome: v.nome})));

              // Forçar recarga do histórico
              console.log("🔄 Forçando recarga do histórico...");
              await carregarHistoricoPontuacoes();
              console.log("✅ Histórico recarregado.");

            } catch (error) {
              console.error('❌ Erro no debug:', error);
            }
       }


   }); // Fim do DOMContentLoaded
 </script>
</body>
</html>
