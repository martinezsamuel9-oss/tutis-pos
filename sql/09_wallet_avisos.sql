-- ============================================================================
--  TUTI'S — Que los puntos del pase de Wallet se actualicen solos
--
--  Correr DESPUÉS de 01..08. Es idempotente.
--
--  Cada vez que cambia el saldo de un cliente, la base le avisa al servicio de
--  pases (wallet.slabblu.com), y este le avisa a Apple para que el iPhone baje
--  el pase nuevo. A la clienta le aparece "Ahora tienes N puntos en Tuti's".
--
--  LA REGLA DE ORO: el aviso NUNCA puede frenar ni tumbar una venta.
--    · pg_net manda la llamada en segundo plano, DESPUÉS de que la venta se
--      confirma. La caja no espera a Wallet.
--    · Si Wallet está caído o tarda, la venta entra igual; lo único que pasa
--      es que el pase se actualiza la próxima vez.
--    · Si encolar el aviso fallara por cualquier razón, se registra una
--      advertencia y la venta sigue.
-- ============================================================================

create extension if not exists pg_net;

-- ----------------------------------------------------------------------------
-- 1. LA CONFIGURACIÓN, EN UN ESQUEMA QUE NO VE LA APLICACIÓN
--    Aquí va el secreto con que la base se identifica ante el servicio de
--    pases. El esquema "privado" no lo publica la API: ni la caja ni nadie con
--    la llave pública lo puede leer. Solo lo lee la función de abajo.
-- ----------------------------------------------------------------------------
create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create table if not exists privado.wallet_config (
  id      boolean primary key default true check (id),
  url     text not null,
  secreto text not null check (length(secreto) >= 32)
);
revoke all on privado.wallet_config from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. EL AVISO
-- ----------------------------------------------------------------------------
create or replace function public.wallet_avisar_cambio()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_cfg privado.wallet_config%rowtype;
begin
  select * into v_cfg from privado.wallet_config where id;
  -- Sin configurar todavía: no se avisa, y nada más.
  if v_cfg.url is null then
    return new;
  end if;

  begin
    perform net.http_post(
      url     := v_cfg.url,
      body    := jsonb_build_object('codigo', new.card_code),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Tutis-Secreto', v_cfg.secreto),
      timeout_milliseconds := 5000
    );
  exception when others then
    raise warning 'No se pudo encolar el aviso a Wallet para %: %', new.card_code, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.wallet_avisar_cambio() from public, anon, authenticated;

-- Solo cuando el SALDO cambia de verdad. Actualizar el nombre o el teléfono
-- de un cliente no le manda nada a su iPhone.
drop trigger if exists trg_wallet_aviso on public.customers;
create trigger trg_wallet_aviso
  after update of points_balance on public.customers
  for each row
  when (old.points_balance is distinct from new.points_balance)
  execute function public.wallet_avisar_cambio();

-- ----------------------------------------------------------------------------
-- 3. CONECTARLO
--    Esto va APARTE, en un archivo que no entra al repositorio, porque lleva
--    el secreto. Tiene esta forma:
--
--    insert into privado.wallet_config (id, url, secreto)
--    values (true, 'https://wallet.slabblu.com/notificar', '<secreto>')
--    on conflict (id) do update set url = excluded.url, secreto = excluded.secreto;
--
--    Para APAGAR los avisos sin borrar nada:
--    delete from privado.wallet_config;
-- ----------------------------------------------------------------------------
