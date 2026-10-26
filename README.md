# Diego's Pizza · demo de pedidos

Sitio de pedidos + panel del local. Sin dependencias (solo Node 18+).

- Sitio: `/`
- Panel: `/panel`  ·  correo `admin@diegospizza.cl`  ·  clave `diegos2026`

## Probar en tu computador
```
npm start
```
Abre http://localhost:3000 (sitio) y http://localhost:3000/panel (panel).

## Publicar en Railway (URL pública)
1. Crea un repositorio en GitHub y sube estos archivos (puedes arrastrarlos en "Add file > Upload files").
2. En Railway: New Project > Deploy from GitHub repo > elige el repositorio.
3. En Settings > Networking pulsa "Generate Domain". Esa es la URL para el cliente.

Variables opcionales (Settings > Variables):
- `ADMIN_EMAIL` y `ADMIN_PASS`: cambia el acceso al panel.
- `DATA_DIR=/data`: guarda los pedidos en un volumen (agrega un Volume montado en `/data`). Sin volumen, los pedidos se borran al reiniciar el servicio, lo que es suficiente para un demo.

## Notas
- Los pedidos se guardan en `data.json` y el panel se actualiza en vivo.
- En el panel, Mi local > "Restablecer datos demo" borra los pedidos y vuelve a cargar los de ejemplo.
- Es un demo: los precios los envía el sitio y el acceso al panel es una sola cuenta. Para uso real conviene validar precios en el servidor y agregar cuentas por usuario.
