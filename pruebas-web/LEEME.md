# Pruebas de la pantalla de venta

Manejan la caja de punta a punta en Chromium, sin tocar la base real:

- `fake-supabase.js` reemplaza al SDK de Supabase con un doble en memoria.
- `fake-serial.js` simula la báscula CAS PD-II en modo NCI: contesta a `W` con
  el peso y sus bytes de estado (estable, en movimiento, tara).

Cubren: la báscula se conecta sola con 9600 7E1, el peso no se puede teclear,
la tara sale del catálogo, no toma el peso mientras el plato se mueve, la línea
pesada queda fija, 150 g + 30 g + vaso de 15 g a 0.45/g = 87.75, la venta
lleva la lectura cruda, anular y recargar quedan registrados, pesos a mano con
PIN (bueno y malo), sin internet, el PIN de la gerente y el reporte de control
de pesos.

Cómo correrlas:

```bash
npm install --no-save playwright && npx playwright install chromium
python3 -m http.server 8799 --bind 127.0.0.1 --directory web &
node pruebas-web/prueba_caja.mjs
```
