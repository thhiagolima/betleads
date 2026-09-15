UPDATE public.email_templates SET body_html = '<!doctype html>
<html lang="pt-BR" style="margin:0; padding:0; background:#05070b;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Última condição disponível para sua conta</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    /* Gmail Android dark mode hooks: keep our dark palette stable when Gmail force-applies its own dark/light theme */
    u + .body .gmail-dark-bg,
    [data-ogsc] .gmail-dark-bg {
      background: #131821 !important;
      background-color: #131821 !important;
    }
    u + .body .gmail-dark-card,
    [data-ogsc] .gmail-dark-card {
      background: #0f141c !important;
      background-color: #0f141c !important;
    }
    u + .body .gmail-dark-deep,
    [data-ogsc] .gmail-dark-deep {
      background: #0c1016 !important;
      background-color: #0c1016 !important;
    }
    body, table, td, p, a, span {
      -webkit-text-size-adjust:100%;
      -ms-text-size-adjust:100%;
    }
    @media screen and (max-width:600px) {
      .mobile-bg {
        padding:0 !important;
        margin:0 !important;
        background:#131821 !important;
        background-color:#131821 !important;
      }
      .mobile-container {
        width:100% !important;
        max-width:100% !important;
        border-radius:0 !important;
        background:#131821 !important;
        background-color:#131821 !important;
      }
      .mobile-section {
        background:#131821 !important;
        background-color:#131821 !important;
      }
      .mobile-dark {
        background:#0c1016 !important;
        background-color:#0c1016 !important;
      }
      .mobile-card {
        background:#0f141c !important;
        background-color:#0f141c !important;
      }
      .mobile-padding {
        padding-left:24px !important;
        padding-right:24px !important;
      }
      .mobile-img {
        width:100% !important;
        max-width:100% !important;
        height:auto !important;
      }
      html, body {
        background:#131821 !important;
        background-color:#131821 !important;
      }
    }
  </style>
</head>

<body class="mobile-bg" bgcolor="#05070b" style="margin:0; padding:0; background:#05070b !important; font-family:Arial, Helvetica, sans-serif; color:#ffffff;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    Cupom de 100% liberado antes da próxima atualização.
  </div>

  <table class="mobile-bg" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#05070b" style="width:100%; background:#05070b !important; margin:0; padding:0;">
    <tr>
      <td class="mobile-bg" align="center" bgcolor="#05070b" style="background:#05070b !important; padding:24px 12px;">

        <table class="mobile-container" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="#131821" style="width:100%; max-width:600px; background:#131821 !important; border-radius:14px; overflow:hidden;">

          <!-- LOGO -->
          <tr>
            <td class="mobile-dark" align="center" bgcolor="#0c1016" style="background:#0c1016 !important; padding:8px 12px 4px 12px; border-bottom:1px solid #1c2230; line-height:0; font-size:0;">
              <img class="mobile-img"
                src="https://i.ibb.co/Rpftpdqb/Captura-de-Tela-2026-06-03-a-s-14-59-36.png"
                alt="PixReals"
                width="120"
                style="display:block; margin:0 auto; width:120px; max-width:120px; height:auto; border:0;"
              >
            </td>
          </tr>

          <!-- BANNER -->
          <tr>
            <td class="mobile-dark" align="center" bgcolor="#0c1016" style="padding:0; background:#0c1016 !important; line-height:0; font-size:0;">
              <a href="https://pixreals.io/" target="_blank" style="display:block; text-decoration:none;">
                <img class="mobile-img"
                  src="https://i.ibb.co/mC10tgdY/Conversao-M2-D7.png"
                  alt="Conversao M2 D7"
                  width="600"
                  style="display:block; width:100%; max-width:600px; height:auto; border:0;"
                >
              </a>
            </td>
          </tr>

          <!-- CONTEÚDO -->
          <tr>
            <td class="mobile-section mobile-padding" bgcolor="#131821" style="padding:34px 34px 28px 34px; background:#131821 !important;">

              <p style="margin:0 0 22px 0; font-size:18px; line-height:1.5; color:#ffffff; font-weight:700;">
                Olá, <span style="color:#d7b15c;">{primeiro_nome}</span>.
              </p>

              <p style="margin:0 0 18px 0; font-size:17px; line-height:1.8; color:#f0f0f0;">
                Antes da próxima atualização do seu perfil, liberamos a
                <span style="color:#d7b15c; font-weight:700;">condição mais forte</span>
                para sua conta.
              </p>

              <p style="margin:0 0 18px 0; font-size:17px; line-height:1.8; color:#f0f0f0;">
                Use o cupom
                <span style="color:#d7b15c; font-weight:700;">ENTRA100</span>
                e receba
                <span style="color:#d7b15c; font-weight:700;">100% de bônus real</span>
                no próximo depósito.
              </p>

              <p style="margin:0 0 26px 0; font-size:17px; line-height:1.8; color:#f0f0f0;">
                Depois dessa atualização, essa condição pode não continuar disponível.
              </p>

              <!-- CARD BENEFÍCIO -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px 0;">
                <tr>
                  <td class="mobile-card" bgcolor="#0f141c" style="background:#0f141c !important; border:1px solid #2a3140; border-radius:12px; padding:22px 20px; text-align:center;">
                    <div style="font-size:13px; line-height:1.4; color:#d7b15c; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">
                      Cupom máximo
                    </div>

                    <div style="font-size:28px; line-height:1.2; color:#ffffff; font-weight:700; margin-bottom:10px;">
                      ENTRA100
                    </div>

                    <div style="font-size:16px; line-height:1.7; color:#d0d4db;">
                      100% de bônus real no próximo depósito
                    </div>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 24px auto;">
                <tr>
                  <td align="center" bgcolor="#d7b15c" style="border-radius:8px;">
                    <a href="https://pixreals.io/" target="_blank" style="display:inline-block; padding:16px 34px; font-size:16px; font-weight:700; color:#111111; text-decoration:none; border-radius:8px;">
                      DOBRAR MINHA BANCA
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 22px 0; font-size:14px; line-height:1.6; color:#b8bec8; text-align:center;">
                Se o botão não funcionar, acesse:
                <a href="https://pixreals.io/" target="_blank" style="color:#d7b15c; text-decoration:underline;">pixreals.io</a>
              </p>

              <!-- BLOCO EXTRA -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td class="mobile-card" bgcolor="#0f141c" style="background:#0f141c !important; border-radius:10px; padding:16px 18px; border:1px solid #242b37;">
                    <p style="margin:0; font-size:14px; line-height:1.7; color:#c9ced6; text-align:center;">
                      <span style="color:#d7b15c; font-weight:700;">Importante:</span>
                      essa é a última liberação desta sequência. A condição pode ser encerrada automaticamente.
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- BLOCO COMUNIDADE -->
          <tr>
            <td class="mobile-section mobile-padding" align="center" bgcolor="#131821" style="padding:0; background:#131821 !important; line-height:0; font-size:0;">
              <a href="https://chat.whatsapp.com/I72L03aghVPBdj3dmMYL4J" target="_blank" style="display:block; text-decoration:none;">
                <img class="mobile-img"
                  src="https://i.ibb.co/ynwqF4D6/COMUNIDADE-WHATSAPP.png"
                  alt="Comunidade PixReals no WhatsApp"
                  width="600"
                  style="display:block; width:100%; max-width:600px; height:auto; border:0;"
                >
              </a>
            </td>
          </tr>

          <tr>
            <td class="mobile-section mobile-padding" bgcolor="#131821" style="padding:26px 34px 28px 34px; background:#131821 !important;">
              <p style="margin:0 0 20px 0; font-size:16px; line-height:1.8; color:#f0f0f0;">
                <span style="color:#d7b15c; font-weight:700;">Quer receber benefícios exclusivos?</span>
                Entre na nossa comunidade do WhatsApp e acompanhe de perto as principais liberações da PixReals: cashback, cupons, bônus e condições especiais para sua conta.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="#d7b15c" style="border-radius:8px;">
                    <a href="https://chat.whatsapp.com/I72L03aghVPBdj3dmMYL4J" target="_blank" style="display:inline-block; padding:15px 32px; font-size:15px; font-weight:700; color:#111111; text-decoration:none; border-radius:8px;">
                      ENTRAR NA COMUNIDADE
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- RODAPÉ -->
          <tr>
            <td class="mobile-dark" bgcolor="#0c1016" style="background:#0c1016 !important; padding:22px 24px; text-align:center; border-top:1px solid #1c2230;">
              <p style="margin:0 0 10px 0; font-size:13px; line-height:1.6; color:#d7b15c; font-weight:700;">
                Jogue com responsabilidade. Conteúdo para maiores de 18 anos.
              </p>

              <p style="margin:0 0 12px 0; font-size:12px; line-height:1.7; color:#8d95a3;">
                Apostas podem causar dependência. Apostar não é uma forma de ganhar dinheiro, é apenas entretenimento.
              </p>

              <p style="margin:0 0 8px 0; font-size:12px; line-height:1.6; color:#6f7683;">
                Você está recebendo este e-mail porque possui cadastro na PixReals.
              </p>

              <p style="margin:0; font-size:12px; line-height:1.6; color:#8d95a3;">
                <a href="{{unsubscribe_url}}" target="_blank" style="color:#9aa3b2; text-decoration:underline;">Gerenciar preferências</a>
                &nbsp;|&nbsp;
                <a href="{{unsubscribe_url}}" target="_blank" style="color:#9aa3b2; text-decoration:underline;">Descadastrar-se</a>
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>

', updated_at = now() WHERE id = '68fa1936-7ea4-4cd8-ade9-e0028651669a';
