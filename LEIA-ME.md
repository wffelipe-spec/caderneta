# Caderneta: app Android da conta no comércio

## O que tem aqui
- `public/` e `src/`: o app (tela de entrar, lançar compra com foto, conta, análise, família), a página de confirmação do lojista (`confirmar.html`) e o extrato do lojista (`extrato.html`).
- `functions/`: o servidor. Lê a foto com a IA (Claude), faz a análise do período e copia cada confirmação para o extrato do lojista.
- `firestore.rules` e `storage.rules`: as regras de segurança (compra confirmada fica travada; extrato só o servidor escreve).
- `android/`: o projeto Android (Capacitor) que vira o APK.

## Configuração única (o responsável faz uma vez)
1. Criar um projeto em https://console.firebase.google.com e ativar o plano Blaze (pago por uso; para uma família fica no gratuito, mas o Google pede cartão).
2. Em Authentication, ativar "E-mail/senha". Criar o Firestore Database e o Storage (região São Paulo, southamerica-east1).
3. Em Configurações do projeto > Seus apps, adicionar um "App da Web" e copiar a configuração para `src/config.js`. Trocar `SEU-PROJETO` pelo id do projeto em `src/config.js` e `.firebaserc`.
4. Criar uma chave da API em https://console.anthropic.com (leitura das fotos; custa centavos por foto).
5. Publicar: `npm ci && node build.mjs`, depois `npx firebase deploy` e `npx firebase functions:secrets:set ANTHROPIC_API_KEY`.

## Gerar o APK
- Pelo GitHub: subir esta pasta num repositório; a ação "Gerar APK" (`.github/workflows/apk.yml`) gera o arquivo `app-debug.apk` em Actions > Artifacts.
- Ou num computador com Android Studio: `npm ci && node build.mjs && npx cap sync android`, depois `cd android && ./gradlew assembleDebug`.

## Instalar nos celulares
Mandar o `.apk` pelo WhatsApp ou Drive, abrir no celular e permitir "instalar apps desta fonte".
O responsável cria a conta escolhendo "Responsável, criar a família"; cada filho escolhe "Da família, tenho o código" e digita o código que aparece na aba Família.

## Como o lojista confere
- Na hora: confirma na tela do celular de quem comprou.
- Depois: recebe um link pelo WhatsApp com o código de conferência da compra.
- O extrato do lojista (link na aba Família) mostra tudo que ele confirmou; só o servidor escreve nele.

## Testar localmente
`npx firebase emulators:start --project demo-caderneta` e abrir `http://127.0.0.1:5000/index.html?emulador=1` (troque antes `src/config.js` por um config com `projectId: "demo-caderneta"`).
