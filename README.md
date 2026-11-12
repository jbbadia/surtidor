# Surtidor

Comparador de precios de **GLP y gasolina** (95 E5, 95 E10, 95 Premium, 98 E5, 98 E10) en España, con los datos oficiales y gratuitos del Ministerio (API REST «Precios de Carburantes», Geoportal de Gasolineras). Sin anuncios, sin cuenta y sin rastreo.

## Arrancar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests del intérprete de horarios
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
- **Ahorro neto con desvío** y orden «Más ahorro»: lo que ahorras al llenar frente a la gasolinera más cercana, descontando el combustible de ir y volver (distancia en línea recta × 1,3).

Si sabes tu consumo real (mira el ordenador de a bordo), cámbialo: será más exacto que el homologado.

## Ofertas para ahorrar

`src/offers.js` guarda un catálogo de ofertas comprobadas a mano (última revisión: 12/11/2026), cada una con su fuente, sus condiciones, si consta que vale para GLP y su fecha de fin. En la web:
- **«La tengo · aplicar»** resta su descuento en los precios de esa marca (una oferta de saldo o cheque cuenta como ahorro solo si luego lo gastas).
- La ficha de cada gasolinera avisa si tiene una oferta que no estás usando.
- Al llegar su fecha, la oferta deja de aplicarse sola y aparece un aviso.

**Para actualizarlas** hay que editar `OFFERS` y `VERIFIED` en `src/offers.js`: estas promociones cambian cada pocas semanas y no existe una API pública con ellas.

## Qué hace

- Mapa (OpenStreetMap + Leaflet) con el precio en cada pin, coloreado de barato a caro dentro de la zona. Los pines que se solaparían se ocultan dando prioridad a los más baratos o cercanos; al hacer zoom aparecen más.
- Búsqueda por **mi ubicación**, **municipio** o **código postal** (sin salir del navegador) y, si no hay coincidencia, por dirección en OpenStreetMap.
- Varios combustibles a la vez; uno es el «principal» (pines y orden), los demás se ven como precio secundario.
- Orden por precio o distancia; filtros por radio, **abiertas ahora**, **low cost** y marca.
- **Precio dudoso**: aviso si el precio no ha cambiado en 30 días mientras ≥80 % de la provincia sí lo hizo, o si es un valor atípico (bajo Q1 − 1,5·IQR y >10 % bajo la mediana). Calibrado con datos reales para no avisar de más.
- Ficha con todos los precios, **mis descuentos** por marca (% o cént/L), **calculadora de llenado**, horario interpretado, **histórico de 30 días** y botones «Cómo llegar» (Google Maps / Apple Mapas).
- **Favoritas** ordenadas por precio y siempre visibles en el mapa.
- Todo lo personal (favoritas, descuentos, preferencias) se guarda solo en el navegador. Los precios se cachean 30 min.

## Archivos

- `src/api.js`: acceso a la API, caché local, histórico y búsqueda de lugares.
- `src/offers.js`: catálogo de ofertas con caducidad y a qué marcas se aplica.
- `src/car.js`: perfil del coche y cálculos (coste por 100 km, autonomía, ahorro neto con desvío).
- `src/horario.js`: interpreta horarios como `L-V: 07:00-14:00 y 16:00-21:00; S: 08:00-14:00` (zona horaria de Canarias incluida).
- `src/main.js`: interfaz (mapa, lista, filtros, ficha, ajustes).
- `src/style.css`: estilos, adaptados a móvil y con modo oscuro.

## Limitaciones conocidas

- El Ministerio da **una fecha global** de actualización, no una por estación: ningún precio puede garantizarse en el surtidor. La web lo indica siempre.
- Los horarios con un solo día suelto (`L: 24H`, ~450 estaciones) son ambiguos y se muestran como «Horario no claro».
- `tile.openstreetmap.org` está bien para uso personal o con poco tráfico; si la web se publica con muchas visitas, conviene cambiar a un proveedor de mapas con plan propio.
