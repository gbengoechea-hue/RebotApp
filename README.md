# RebotApp — ¿Va a dar la rebotá?

La **rebotá** es una caída brusca de la temperatura: que en las próximas 24 horas alguna hora vaya a estar **8 °C o más** por debajo de la misma hora del día anterior.

RebotApp es una web que cualquiera puede usar desde un enlace: indica su localidad (o usa la ubicación del móvil), ve al momento si va a dar la rebotá y, si quiere, activa un aviso para recibir una notificación en el móvil cada vez que vaya a dar.

- Pronóstico: [Open-Meteo](https://open-meteo.com) (gratuito, sin clave).
- Notificaciones: [ntfy](https://ntfy.sh) (app gratuita para Android e iPhone, sin registro).
- Revisión automática a las 8:00 y a las 20:00 (hora de Madrid).

## Cómo decide si va a dar la rebotá

Para cada hora de las próximas 24 h compara la temperatura prevista con la de **la misma hora del día anterior**. Así no salta por el enfriamiento normal de la noche (en Madrid es habitual bajar 12–15 °C de la tarde a la madrugada) y sí salta con frentes fríos, DANAs o entradas de aire polar. Tras un aviso, no repite durante 18 h.

## Probarlo en tu ordenador

```bash
pip install -r requirements.txt
python app.py
```

Abre http://localhost:5000, consulta tu localidad, pulsa *Avísame* y luego "Enviar notificación de prueba".
Para forzar una revisión inmediata de todos los suscriptores: `python app.py revisar`.

## Publicarlo para compartir el enlace

### En Render (recomendado)

La carpeta incluye `render.yaml`, que deja todo configurado: servidor en Frankfurt, disco de 1 GB para guardar las suscripciones y revisión a las 8:00 y 20:00.

1. **GitHub**: crea un repositorio nuevo (puede ser privado) en github.com → *New repository* → *uploading an existing file*, y arrastra los cuatro archivos: `app.py`, `requirements.txt`, `render.yaml` y `README.md`.
2. **Render**: crea una cuenta en render.com (puedes entrar con GitHub) y añade un método de pago.
3. Pulsa **New → Blueprint**, conecta tu cuenta de GitHub, elige el repositorio y pulsa **Apply**. Render lee `render.yaml` y lo monta solo; tarda unos minutos.
4. Cuando aparezca *Live*, tendrás una dirección del tipo `https://rebotapp-xxxx.onrender.com`. Ese es el enlace que compartes.
5. Entra tú primero, consulta tu localidad, pulsa *Avísame* y luego *Enviar notificación de prueba* para comprobar que llega al móvil.

Coste: el plan de pago más pequeño de Render más el disco; consulta render.com/pricing. El plan gratuito no sirve: se duerme cuando nadie visita la web (y entonces no revisa a las 8:00) y no admite disco (las suscripciones se perderían).

Para cambiar el umbral o las horas más adelante: en Render, *Environment* → edita `UMBRAL_C` o `HORAS_REVISION` → guarda (se reinicia solo).

### En un VPS o PythonAnywhere

Sirve la web con `ACTIVAR_PROGRAMADOR=0 gunicorn -w 1 -b 0.0.0.0:8000 app:app` y programa la revisión con cron:
`0 8,20 * * * cd /ruta/rebotapp && python app.py revisar`

## Configuración (variables de entorno)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `UMBRAL_C` | `8` | Grados de caída que disparan el aviso |
| `HORAS_REVISION` | `8,20` | Horas de revisión |
| `ZONA_PROGRAMADOR` | `Europe/Madrid` | Zona horaria de esas horas |
| `HORAS_ENTRE_AVISOS` | `18` | Silencio tras un aviso |
| `DB_PATH` | `alertas.db` | Base de datos SQLite |
| `NTFY_SERVER` | `https://ntfy.sh` | Servidor ntfy (puedes usar uno propio) |
| `ACTIVAR_PROGRAMADOR` | `1` | `0` si la revisión la hace cron |

## Privacidad

Cada suscriptor recibe un canal ntfy aleatorio difícil de adivinar, pero los canales de ntfy.sh son públicos para quien conozca su nombre: los avisos no contienen datos personales, solo la localidad y la temperatura. Para más control, se puede apuntar `NTFY_SERVER` a un servidor ntfy propio.
