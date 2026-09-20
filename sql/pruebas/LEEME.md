# Pruebas de seguridad

Estos archivos comprueban que el aislamiento entre sucursales realmente
funciona. Ya se corrieron contra PostgreSQL 16 antes de entregarte el sistema,
y todas pasaron:

- La cajera de Galerías solo ve Galerías (1 sucursal, 9 toppings de una sola tienda).
- El gerente de Multiplaza no ve nada de Galerías.
- El propietario ve las 2 sucursales (18 toppings, ambas tiendas).
- La cajera no puede cambiar precios ni costos (0 filas modificadas).
- El gerente sí puede, pero solo en su tienda (1 fila, no 2).
- Una venta descuenta inventario correctamente y solo en su sucursal.
- Reenviar la misma venta no la duplica ni descuenta inventario dos veces.
- Aun conociendo el UUID de la otra sucursal, la cajera no puede cobrar ahí,
  ni leer su inventario, ni pedir su cierre del día.

Si algún día modificas las políticas de seguridad, vale la pena volver a
correrlas. Se pueden ejecutar en el SQL Editor de un proyecto Supabase de
prueba (nunca en el de producción: crean usuarios y ventas ficticias).
