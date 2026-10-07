# La computadora de la caja

Aquí está lo necesario para preparar cada computadora de caja: la báscula
conectada y Chrome en modo kiosko. Son las dos piezas que hacen cumplir la regla
de que **lo pesado queda fijo**.

| Archivo | Para qué |
|---|---|
| `politicas-kiosko.reg` | Bloquea Chrome: solo abre la caja, sin herramientas de desarrollador, sin extensiones y sin guardar contraseñas |
| `abrir-caja.bat` | Abre la caja en pantalla completa e imprime el comprobante sin la ventana de vista previa |
| `quitar-politicas.reg` | Deshace lo anterior. Solo para soporte técnico |

## 1. La báscula (CAS PD-II)

La caja le pide el peso a la báscula; nadie lo teclea. Para eso:

1. **Cable.** Se usa el puerto RS-232 de la báscula (atrás, junto al
   interruptor), su cable serial y un **adaptador USB a serial**.
   Recomendación: un adaptador con chip FTDI, que en Windows instala solo su
   controlador. Si el cable no vino con la báscula, se le pide al distribuidor
   de CAS como "cable RS-232 de la PD-II para PC".
2. **Modo de la báscula: tYPE-5** (NCI General). Con la báscula apagada, se
   mantiene presionada la tecla de configuración y se enciende. La pantalla
   muestra `EcrSEt` y luego el tipo actual. Se avanza hasta `tYPE-5` y se
   guarda con **ZERO**. Está en la página 9 del
   [manual](https://www.casscale.com.au/wp-content/uploads/PDII-User-Manual.pdf).
3. **Primera vez en cada computadora:** en la pantalla de venta, botón
   **Conectar báscula** y se elige el puerto del adaptador. Si ya están puestas
   las políticas de abajo, no lo pregunta: se conecta sola.

Lo que la caja revisa en cada pesada:

- Solo toma el peso cuando la báscula dice que está **estable**.
- Si la báscula avisa que tiene una tara puesta, no acepta la lectura.
- La tara del vaso sale del catálogo, no de la báscula ni del teclado.
- Todo se pesa sobre el mismo vaso, sin quitarlo. A cada topping le toca lo que
  subió la báscula desde la pesada anterior.
- Una línea ya pesada no se borra ni se cambia. Anular el pedido completo sí se
  puede, y queda registrado con nombre, motivo y peso. Si alguien recarga la
  caja con un pedido pesado sin cobrar, al volver queda registrado como anulado.
- La báscula puede venir en libras, kilos u onzas: la caja convierte y guarda
  todo en gramos.

**Si la báscula falla**, la venta no se detiene. Se presiona *La báscula no
funciona*, se teclean los pesos, y al cobrar una gerente los revisa y los
aprueba con su PIN. Cada gerente pone su PIN en **Configuración → Mi PIN de
autorización**. Sin internet no hay cómo validar el PIN: se cobra igual, y la
venta queda marcada en rojo como *peso a mano SIN PIN*.

Todo eso se ve en **Reportes → Control de pesos**, por cajera.

## 2. Chrome en modo kiosko (Windows)

**Solo en computadoras que se usen exclusivamente como caja.** Las políticas
aplican a todo Chrome de esa computadora: con ellas no abre ningún otro sitio.

1. Entrar con una cuenta de **administrador** de Windows.
2. Doble clic en `politicas-kiosko.reg` y aceptar.
3. Copiar `abrir-caja.bat` a la carpeta de inicio de todos los usuarios: tecla
   Windows + R, escribir `shell:common startup` y pegarlo ahí.
4. Que la cajera use una **cuenta estándar de Windows**, sin permisos de
   administrador. Así no puede quitar las políticas.
5. Reiniciar. La caja debe abrir sola, en pantalla completa.

Para revisar que quedó bien: en esa computadora, abrir Chrome en
`chrome://policy` (es la única página interna que se dejó abierta). Ahí deben
aparecer las políticas. Además, F12 y Ctrl+Shift+I no deben abrir nada.

Para salir del modo kiosko (soporte técnico): Alt+F4 cierra Chrome. Aunque se
vuelva a abrir Chrome de forma normal, las políticas siguen activas.

Ojo: si Chrome ya estaba abierto en modo normal, `abrir-caja.bat` abre una
ventana normal en vez del kiosko. Hay que cerrar Chrome por completo antes.

## Qué protege esto y qué no

**Protege:**
- Que el peso se teclee: el campo no existe; solo hay botón de pesar.
- Que una línea pesada se borre o se cambie, o que el pedido se tire sin
  registro.
- Que alguien abra la consola de Chrome para fabricar una lectura o modificar
  una venta. Para eso son las políticas: sin herramientas de desarrollador ni
  extensiones, no hay por dónde meter código.
- Que la gerente "autorice" sin ver: aprueba el peso exacto que ve en pantalla,
  una sola vez, para una sola venta. El PIN se valida en el servidor, con
  bcrypt y con tope de 5 intentos fallidos en 15 minutos.

**No protege, y ningún software puede:**
- Engañar a la báscula por fuera: presionar ZERO con el vaso vacío encima (la
  báscula deja de contar esos gramos), apoyar la mano en el plato o servir más
  después de pesar. Eso lo destapa el **cuadre de inventario**: si lo vendido
  según la báscula no cuadra con el yogurt que se gastó según las compras, la
  diferencia aparece por tienda.
- Una computadora con administrador de Windows en manos de la cajera. Con
  administrador se pueden quitar las políticas. Para cerrarlo del todo existe el
  "acceso asignado" de Windows (Windows Pro), que deja la computadora con una
  sola aplicación.
