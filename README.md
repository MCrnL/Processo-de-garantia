# Processo-de-garantia
Checklist de Vistoria (PWA)

Como colocar no ar (precisa de HTTPS para a câmera e a instalação funcionarem):
1. GitHub Pages: suba estes 7 arquivos para um repositório e ative Pages em Settings > Pages.
   Ou Firebase Hosting: copie os arquivos para a pasta public e rode "firebase deploy --only hosting".
2. Abra o link no celular.
   Android (Chrome): botão "Instalar" no topo ou menu > Adicionar à tela inicial.
   iPhone (Safari): Compartilhar > Adicionar à Tela de Início.
3. Abra uma vez com internet para o app ficar disponível offline.

Para publicar uma nova versão, troque VERSION em sw.js (ex.: vistoria-v2).
