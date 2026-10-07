// ============================================================================
//  CONFIGURACIÓN — el único archivo que tienes que editar
//
//  Dónde encontrar estos dos valores:
//    Supabase → tu proyecto → Settings (engranaje) → API
//      · "Project URL"  → pégalo en SUPABASE_URL
//      · "anon public"  → pégalo en SUPABASE_ANON_KEY
//
//  ¿Es seguro que la llave "anon" quede en un archivo que ve el navegador?
//  Sí. Esa llave está diseñada para ser pública: por sí sola no da acceso a
//  nada, porque quien decide qué puede ver y hacer cada usuario son las
//  políticas de seguridad (RLS) que instalamos en la base de datos.
//  La que NUNCA debe ir aquí es la llave "service_role": esa sí se salta
//  todas las políticas. Si alguna vez la pegas aquí por error, ve a Supabase
//  y regenérala de inmediato.
// ============================================================================

window.TUTIS_CONFIG = {
  SUPABASE_URL: "https://cykvmzendayjvkxzbhha.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5a3ZtemVuZGF5anZreHpiaGhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NjcyNTEsImV4cCI6MjEwNTQ0MzI1MX0.-7XCQS4FvwEVqlL6YeSbeuOh8hPIPgIJZ7nYAUimXDw",

  // Desfase horario de las tiendas respecto a UTC. Guatemala, El Salvador y
  // Honduras son todos UTC-6, así que normalmente no hay que tocarlo. Esto es
  // lo que hace que "el cierre del día" corresponda al día real del negocio.
  UTC_OFFSET_HOURS: -6,

  // Báscula. Lo de abajo es lo que usa la CAS PD-II (9600 baudios, 7 bits,
  // paridad par, 1 bit de parada). Solo hay que tocarlo si se cambia de
  // modelo de báscula. Cómo configurar la báscula: caja/LEEME.md.
  SCALE_BAUD_RATE: 9600,
  SCALE_DATA_BITS: 7,
  SCALE_PARITY: "even",
  SCALE_STOP_BITS: 1,

  // Servicio de pases de Apple Wallet y Google Wallet. Cada uno se enciende
  // aparte, cuando su certificado o su cuenta estén configurados.
  WALLET_URL: "https://wallet.slabblu.com",
  WALLET_APPLE: true,
  WALLET_GOOGLE: false,
};
