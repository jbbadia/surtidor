# Repostaje Rocío

> Antes se llamaba «Surtidor». La carpeta, el repositorio y la dirección web conservan ese nombre para no romper los enlaces ni los datos guardados en cada navegador.

Comparador de precios de **GLP y gasolina** (95 E5, 95 E10, 95 Premium, 98 E5, 98 E10) en España, con los datos oficiales y gratuitos del Ministerio (API REST «Precios de Carburantes», Geoportal de Gasolineras). Sin anuncios, sin cuenta y sin rastreo.

## Arrancar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests de los cálculos (horarios, coche, viaje, diario, avisos…)
npm run build      # web estática en dist/ (se puede subir a cualquier hosting)
```

No necesita servidor propio: la API del Ministerio permite CORS y la web la llama directamente desde el navegador.

## Personalizada para un Dacia Sandero ECO-G 100 (2024)

Coche bifuel GLP/gasolina. Valores por defecto (editables en «Mi coche»):

| | GLP | Gasolina |
|---|---|---|
| Litros por repostaje | 32 (depósito de 40 L, se llena al 80 %) | 50 |
| Consumo homologado WLTP | 7,4 L/100 km | 5,6 L/100 km |

Con eso la web muestra:
- **Coste por 100 km de GLP frente a gasolina** con los mejores precios de la zona. El GLP gasta más litros, así que comparar solo €/L engaña.
- En cada gasolinera: **cuánto cuesta llenar** cada depósito, coste por 100 km y **autonomía**.
- **Lo que cuesta ir** a cada gasolinera («Ir cuesta 0,14 €» en la lista y en la ficha): km por carretera aproximados × el consumo medio de «Mi coche» × el precio de esa gasolinera.
- **Ahorro neto con desvío** y orden «Más ahorro»: lo que ahorras al llenar frente a la gasolinera más cercana, descontando el combustible de ir y volver (distancia en línea recta × 1,3).

Si sabes tu consumo real (mira el ordenador de a bordo), cámbialo: será más exacto que el homologado.

## Cómo se actualizan los precios

- Las gasolineras están obligadas a comunicar sus precios al Ministerio cada vez que los cambian y, como mínimo, cada lunes (Orden ITC/2308/2007). La CNMC vigila que lo cumplan.
- El Ministerio los publica en su API al momento. El campo `Fecha` de la API es la hora de la consulta, no la del último cambio.
- La web los descarga al abrirla, cada 30 minutos mientras está abierta, al volver a ella tras más de 30 minutos y con el botón «Actualizar». El recuadro «Precios actualizados» muestra el día y la hora de esa descarga.
- El Ministerio no da la hora del cambio de cada gasolinera. La ficha calcula el **día del último cambio** a partir del histórico diario (`src/history.js`).

## Instalar en el móvil

Es una web instalable (`public/manifest.webmanifest` y los iconos). El banner «Añádela a tu pantalla de inicio»:
- **En iPhone:** muestra los pasos exactos para Safari, Chrome, Edge o Firefox, porque iOS no permite instalar con un botón. Si estás dentro de otra app, como Instagram, te pide abrirla primero en Safari.
- **En Android, Chrome y Edge:** instala directamente.

No aparece si ya está abierta como app ni si pulsaste «Ahora no».

## Viaje: dónde repostar por el camino

Pestaña «Viaje». Con la salida y el destino (y, si se marca, **ida y vuelta**):
- Calcula la ruta por carretera (OSRM sobre OpenStreetMap, `src/route.js`) y el **gasto medio del viaje** con GLP y con gasolina, usando el consumo de «Mi coche» y la mediana de precios de las gasolineras que quedan junto a la ruta.
- Propone dónde parar, según el combustible que llevas al salir (`src/trip.js`):
  - **Más barata:** compra lo justo en las caras y llena en las baratas, desviándose si compensa contando el rodeo; no añade una parada si ahorra menos de 2 €. Con GLP el plan **nunca cuenta con la gasolina**: si el depósito no llega, para antes en otra gasolinera con GLP, aunque sea más cara. Tampoco manda rellenar un par de litros en un depósito casi lleno: cada parada es de al menos 5 L (o el 15 % del depósito) siempre que haya alternativa.
  - **Más rápida:** las menos paradas posibles y pegadas a la carretera, sin mirar el precio.
- Si no hace falta repostar, cada modo enseña una parada opcional (la más barata de la ruta o la más barata junto a la carretera).
- Se puede elegir **con cuánto depósito llegar** (1/4, la mitad, 3/4 o lleno; en ida y vuelta, al volver). Si no hay gasolineras para conseguirlo, llega con lo más que se pueda y lo dice.
- No propone dos paradas a menos de 40 km una de otra si evitarlo cuesta poco, ni desvíos largos por poco ahorro (cada km de rodeo cuenta 0,15 € además del combustible). Cada parada apartada de la ruta indica lo que cuesta el desvío.
- Solo si no hay ninguna gasolinera con GLP al alcance en un tramo, avisa de que ahí el coche pasará a gasolina y lo que costará.
- Enseña el viaje en orden: salida, paradas numeradas (con «Llena el depósito» o «Echa al menos X L»), tramos con gasolina y llegada; en ida y vuelta, separado en «Ida» y «Vuelta». En ida y vuelta, una gasolinera junto al destino cuenta como una sola parada.
- Dibuja la ruta y las paradas en el mapa con su número (una gasolinera usada a la ida y a la vuelta lleva los dos, «1·4») y abre la ruta con sus paradas en Google Maps.

Donde pone «al menos», los litros son los mínimos para llegar con unos 30 km de margen. La distancia de cada gasolinera a la ruta es en línea recta (GLP: hasta 12 km; gasolina: hasta 6 km).

## Diario de repostajes

Pestaña «Diario» (o «Apuntar repostaje aquí» en la ficha de una gasolinera). Se guarda solo en el dispositivo y calcula (`src/log.js`):
- **Gasto por mes**, separado en GLP y gasolina.
- **Consumo real de GLP**, con los km del coche de dos repostajes de GLP (supone que llenas; descuenta los km hechos con la gasolina repostada entre medias). Con un toque se pasa a «Mi coche».
- **Ahorro por ir con GLP**: lo que habrían costado esos km con gasolina al precio de ese día.

Se puede exportar a CSV para Excel o Numbers.

## Avisos y mejor día

- **Al abrir la web** aparecen los cambios de precio de tus favoritas desde la última visita y, si pones un precio objetivo en los ajustes, las gasolineras con GLP igual o más barato (`src/alerts.js`). No hay notificaciones con la web cerrada: harían falta un servidor que vigile los precios y un servicio de envío.
- **¿Qué día repostar?** Compara la mediana diaria del GLP de la provincia durante 8 semanas. Solo señala un día si es al menos 0,3 cént/L más barato que su semana y se repite en 3 de cada 4 semanas; si no, dice que da igual.

## Sin conexión

- `public/sw.js` guarda la propia web (HTML, código, iconos y fuentes) para abrirla sin cobertura. Solo se activa en la versión publicada.
- Los precios y el catálogo de gasolineras se guardan en IndexedDB (`src/store.js`). Sin red se muestran los últimos descargados, con su hora y un aviso.
- El mapa, las rutas y los históricos necesitan conexión.

## Ofertas para ahorrar

`src/offers.js` guarda un catálogo de ofertas comprobadas a mano (última revisión: 12/11/2026), cada una con su fuente, sus condiciones, si consta que vale para GLP y su fecha de fin. En la web:
- **«La tengo · aplicar»** resta su descuento en los precios de esa marca (una oferta de saldo o cheque cuenta como ahorro solo si luego lo gastas).
- La ficha de cada gasolinera avisa si tiene una oferta que no estás usando.
- Al llegar su fecha, la oferta deja de aplicarse sola y aparece un aviso.

**Para actualizarlas** hay que editar `OFFERS` y `VERIFIED` en `src/offers.js`: estas promociones cambian cada pocas semanas y no existe una API pública con ellas.

## Qué hace

- Mapa (OpenFreeMap + Leaflet) con el precio en cada pin, coloreado de barato a caro dentro de la zona. Los pines que se solaparían se ocultan dando prioridad a los más baratos o cercanos; al hacer zoom aparecen más.
- Búsqueda por **mi ubicación**, **municipio** o **código postal** (sin salir del navegador) y, si no hay coincidencia, por dirección en OpenStreetMap.
- Varios combustibles a la vez; uno es el «principal» (pines y orden), los demás se ven como precio secundario.
- Orden por precio o distancia; filtros por radio, **abiertas ahora**, **low cost** y marca.
- **Precio dudoso**: aviso si el precio no ha cambiado en 30 días mientras ≥80 % de la provincia sí lo hizo, o si es un valor atípico (bajo Q1 − 1,5·IQR y >10 % bajo la mediana). Calibrado con datos reales para no avisar de más.
- Ficha con todos los precios, **mis descuentos** por marca (% o cént/L), **calculadora de llenado**, horario interpretado, **histórico de 30 días** y botones «Cómo llegar» (Google Maps / Apple Mapas).
- **Favoritas** ordenadas por precio y siempre visibles en el mapa.
- Todo lo personal (favoritas, descuentos, preferencias, diario) se guarda solo en el navegador. Los precios se cachean 30 min.

## Archivos

- `src/api.js`: acceso a la API, caché local, histórico y búsqueda de lugares.
- `src/store.js`: almacén en IndexedDB para el catálogo y los precios.
- `src/trip.js`, `src/route.js`, `src/trip-ui.js`: planificador de viaje (cálculo, ruta y pantalla).
- `src/log.js`, `src/log-ui.js`: diario de repostajes (cálculo y pantalla).
- `src/alerts.js`, `src/history.js`: avisos de precio, último cambio y mejor día de la semana.
- `public/sw.js`: service worker para abrir la web sin conexión.
- `src/offers.js`: catálogo de ofertas con caducidad y a qué marcas se aplica.
- `src/car.js`: perfil del coche y cálculos (coste por 100 km, autonomía, ahorro neto con desvío).
- `src/horario.js`: interpreta horarios como `L-V: 07:00-14:00 y 16:00-21:00; S: 08:00-14:00` (zona horaria de Canarias incluida).
- `src/main.js`: interfaz (mapa, lista, filtros, ficha, ajustes).
- `src/style.css`: estilos, adaptados a móvil y con modo oscuro.

## Limitaciones conocidas

- El Ministerio da **una fecha global** de actualización, no una por estación: ningún precio puede garantizarse en el surtidor. La web lo indica siempre.
- Los horarios con un solo día suelto (`L: 24H`, ~450 estaciones) son ambiguos y se muestran como «Horario no claro».
- Los servidores públicos de rutas (OSRM) y de mapas (OpenFreeMap) son gratuitos y sin garantía: valen para uso personal, no para muchas visitas.
- En el viaje, el desvío a cada gasolinera es una estimación en línea recta y no se tiene en cuenta si estará abierta cuando llegues.
