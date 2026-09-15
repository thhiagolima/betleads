UPDATE public.email_templates SET body_html=$LOV$<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<title>{{assunto}}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#e5e7eb">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">{{preheader}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#11131a;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(201,168,76,.10);border:1px solid #1f2230">

      <!-- HEADER / LOGO -->
      <tr><td align="center" style="background:linear-gradient(180deg,#0b0d14,#11131a);padding:28px 24px 22px">
        <img src="{{logo_url}}" alt="{{brand_name}}" width="220" style="max-width:220px;height:auto;display:block;margin:0 auto;border:0"/>
        <div style="margin-top:14px;font:600 12px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:3px;color:#c9a84c;text-transform:uppercase">{{headline_superior}}</div>
      </td></tr>

      <!-- HERO -->
      <tr><td style="padding:0">
        <img src="{{hero_image_url}}" alt="{{hero_alt}}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"/>
      </td></tr>

      <!-- CONTEÚDO -->
      <tr><td style="padding:30px 28px 8px;background:#11131a">
        <h1 style="margin:0 0 14px;font:700 22px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#ffffff;text-align:left">{{saudacao}}</h1>
        <p style="margin:0 0 14px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#d1d5db">{{texto_principal}}</p>
        <p style="margin:0 0 6px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#9ca3af">{{texto_secundario}}</p>
      </td></tr>

      <!-- CARD BENEFÍCIO / CUPOM (remover bloco se não usar) -->
      <tr><td style="padding:18px 28px 8px;background:#11131a">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg,#161a26,#0f1219);border:1px solid #c9a84c;border-radius:14px;box-shadow:0 0 24px rgba(201,168,76,.18)">
          <tr><td align="center" style="padding:22px 18px">
            <div style="font:700 12px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:3px;color:#c9a84c;text-transform:uppercase;margin-bottom:10px">{{beneficio_titulo}}</div>
            <div style="display:inline-block;border:2px dashed #c9a84c;border-radius:10px;padding:12px 24px;font:800 22px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:3px;color:#ffd56a;background:rgba(201,168,76,.08);margin-bottom:12px">{{cupom}}</div>
            <div style="font:600 16px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#ffffff">{{beneficio_descricao}}</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:24px 28px 8px;background:#11131a">
        <a href="{{cta_url}}" style="display:inline-block;background:linear-gradient(180deg,#e4c068,#c9a84c);color:#0a0a0f;text-decoration:none;font:800 16px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:16px 38px;border-radius:12px;box-shadow:0 6px 20px rgba(201,168,76,.35)">{{cta_texto}}</a>
      </td></tr>

      <!-- LINK ALTERNATIVO (remover bloco se não usar) -->
      <tr><td align="center" style="padding:6px 28px 18px;background:#11131a">
        <p style="margin:0;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#9ca3af">Se o botão não funcionar, acesse:<br/>
          <a href="{{link_deposito}}" style="color:#c9a84c;text-decoration:underline;word-break:break-all">{{link_deposito}}</a>
        </p>
      </td></tr>

      <!-- BLOCO EXTRA (remover bloco se não usar) -->
      <tr><td style="padding:8px 28px 8px;background:#11131a">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1626;border:1px solid #1e3a8a;border-radius:12px">
          <tr><td style="padding:16px 18px">
            <div style="font:700 12px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px;color:#60a5fa;text-transform:uppercase;margin-bottom:6px">{{extra_titulo}}</div>
            <div style="font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#cbd5e1">{{extra_texto}}</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- URGÊNCIA (remover bloco se não usar) -->
      <tr><td align="center" style="padding:14px 28px 4px;background:#11131a">
        <p style="margin:0;font:600 12px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fca5a5">⚠ {{urgencia_texto}}</p>
      </td></tr>

      <!-- JOGO RESPONSÁVEL -->
      <tr><td style="padding:22px 28px;background:#0b0d14;border-top:1px solid #1f2230">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="56" valign="top" style="padding-right:12px">
              <div style="width:44px;height:44px;border-radius:50%;border:2px solid #ef4444;color:#ef4444;text-align:center;font:800 14px/40px -apple-system,Segoe UI,Roboto,Arial,sans-serif">18+</div>
            </td>
            <td style="font:400 11px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#9ca3af">
              Jogue com responsabilidade. Proibido para menores de 18 anos.<br/>
              Apostas podem causar dependência. Aposte apenas por entretenimento.
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- RODAPÉ -->
      <tr><td style="background:#08090d;padding:18px 24px;text-align:center;font:400 11px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#6b7280">
        Você está recebendo este e-mail porque possui cadastro na plataforma {{brand_name}}.<br/>
        {{company_address}}<br/>
        <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Gerenciar preferências</a> &nbsp;|&nbsp;
        <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Descadastrar-se</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>$LOV$,
body_text=$LOV$
{{saudacao}}

{{texto_principal}}

{{texto_secundario}}

{{beneficio_titulo}}: {{cupom}}
{{beneficio_descricao}}

{{cta_texto}}: {{cta_url}}

{{extra_titulo}}
{{extra_texto}}

{{urgencia_texto}}

Jogue com responsabilidade. Proibido para menores de 18 anos.
Descadastrar: {{unsubscribe_url}}
$LOV$,
subject='{{assunto}}',
preheader='{{preheader}}',
tags=ARRAY['mestre','pixreals','retorno','vip','conversao'],
is_active=true
WHERE name='Template Mestre Pixreals';