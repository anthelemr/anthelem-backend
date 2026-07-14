// Pluggable email sender. Swap the body of sendEmail() for your real
// provider (Postmark, SES, Resend, SendGrid, etc.) — every route that
// needs to send mail already calls this one function, so wiring a real
// provider later means editing this file only, nothing that calls it.

export async function sendEmail({ to, subject, text }) {
  if (!process.env.EMAIL_PROVIDER_API_KEY || process.env.EMAIL_PROVIDER_API_KEY.includes('replace_me')) {
    console.log(`[email:stub] Would send to ${to} — "${subject}"\n${text}`);
    return { stubbed: true };
  }

  // Example wiring for a generic HTTP email API — replace with your provider's SDK:
  //
  // const res = await fetch('https://api.yourprovider.com/send', {
  //   method: 'POST',
  //   headers: {
  //     Authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text }),
  // });
  // if (!res.ok) throw new Error('Email send failed: ' + (await res.text()));
  // return res.json();

  console.log(`[email:unconfigured] No provider wired yet — to ${to}: "${subject}"`);
  return { stubbed: true };
}
