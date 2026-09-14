# Geyser Card

A Home Assistant dashboard card for a solar geyser (water heater). It shows the
collector temperature, the tank temperature and whether the element is on, and
gives you a setpoint control and a boost button. It comes in **three selectable
layouts**.

![Geyser Card](https://raw.githubusercontent.com/rumpushome/geyser-card/main/images/preview.png)

| `style` | What it is |
| --- | --- |
| `tank` *(default)* | A tank filled to the water's temperature, with the collector above it. The pipe between them animates only while the collector is genuinely hotter, and the element coil glows when it's on. Drag the dashed line to set the target. |
| `dial` | Two rings, the collector outside and the tank inside, with a key naming each. The target is a notch cut into the tank ring. |
| `console` | Flat stat blocks plus one shared temperature scale showing the tank, collector and target. Plus/minus buttons instead of dragging. |

All three show the same information from the same entities. You switch layouts
from a dropdown in the visual editor.

Works with any geyser controller that exposes these as Home Assistant entities,
for example a Geyserwala.

For a display-only version with an animated picture of the whole system, see the
[Solar Geyser Card](https://github.com/rumpushome/solar-geyser-card).

## Install

### HACS

[![Open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rumpushome&repository=geyser-card&category=plugin)

Or add it by hand:
1. Go to **HACS → ⋮ → Custom repositories**.
2. Paste `https://github.com/rumpushome/geyser-card` and choose type **Dashboard**.
3. Download **Geyser Card**. HACS adds the dashboard resource for you.

### Manual

1. Download `geyser-card.js` from the
   [latest release](https://github.com/rumpushome/geyser-card/releases/latest)
   and copy it into `config/www/`.
2. **Settings → Dashboards → ⋮ → Resources → + Add Resource**
   - URL: `/local/geyser-card.js?v=1`
   - Type: **JavaScript Module**
3. Hard-refresh, then **+ Add Card** → **Geyser Card**.

> Bump the `?v=` number every time you replace the file.

## Configuration

```yaml
type: custom:geyser-card
style: tank
name: Geyser
water_entity: sensor.geyser_water_temperature
collector_entity: sensor.geyser_collector_temperature
element_entity: binary_sensor.geyser_element
setpoint_entity: number.geyser_setpoint
boost_entity: automation.boost_geyser
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `water_entity` | entity | **required** | Tank temperature sensor. |
| `style` | string | `tank` | `tank`, `dial` or `console`. |
| `collector_entity` | entity | – | Solar collector temperature. Leave it out and the collector parts disappear. |
| `element_entity` | entity | – | `binary_sensor` or `switch`. Drives the boost button and the heating indicator. |
| `setpoint_entity` | entity | – | A `number` entity. Leave it out and the card becomes read-only. |
| `boost_entity` | entity | – | Automation or script to run when boosting. Leave it out and the button disappears. |
| `stop_entity` | entity | `boost_entity` | What runs when stopping. See below. |
| `name` | string | friendly name | Card title. |
| `round` | number | `1` | Decimal places for temperatures. |
| `step` | number | entity's step | How far one press or slider notch moves the setpoint. |
| `value_size` | number | `44` | Temperature font size in px. **`console` only.** |
| `min` / `max` | number | auto | Gauge scale. Auto = 10 to at least 90, widened in steps of 10 if the collector runs hotter. |
| `show_boost` | bool | `true` | Show the boost button. |
| `animate` | bool | `true` | Entry animations and the flow/glow indicators. |

Every entity except `water_entity` is optional, and the card copes without them:
leave out the collector and the solar parts disappear rather than showing blanks.

### The boost button

Its state depends entirely on `element_entity`:

- **Element off**: `Boost to 55°` (read from the current setpoint), normal styling.
- **Element on**: `Stop boost`, solid red, with a subtle sweep so it's clearly live.

Tapping calls the right action for the entity's domain automatically:
`automation.trigger` (with `skip_condition: true`), `script.turn_on`, or `toggle`
for a switch.

**`stop_entity` is the one thing to check.** By default, stopping triggers
`boost_entity` again, which is right if your automation toggles. If stopping needs
a *different* automation, set it explicitly:

```yaml
boost_entity: automation.boost_geyser
stop_entity: automation.stop_geyser_boost
```

### The setpoint control

The allowed range comes from the `number` entity itself, from its `min`, `max`
and `step` attributes. So the card can never offer a value the device would
reject, and you don't have to configure the range twice.

Changes are sent only once you settle on a value. Dragging updates the display
instantly, but only the value you let go on is sent, so a drag across the range
makes one `number.set_value` call rather than fifty. While a change is on its way
the card keeps showing your value and ignores older updates, until the device
agrees (or 8 seconds pass).

The card also won't redraw while you're dragging, because a redraw part-way
through would swap the control out from under your finger.

### Sizing for a wall tablet

The `console` layout's two temperatures are sized by `value_size` (px, default `44`):

```yaml
style: console
value_size: 60
```

The unit, the target readout and the plus/minus buttons all scale with it, so the
whole card stays in proportion. The buttons stop growing at 60px, though:
they only need to be comfortable to tap, and past that they just take up space.

The collector and geyser blocks always stay **side by side**. Rather than
wrapping or overflowing on a narrow card, the text shrinks to fit its column. So
`value_size` is an upper limit rather than a promise: on a 330px card the
temperatures top out around 45px however high you set it, and on a 640px card
they render at the full size you asked for. Widen the card if you want bigger
numbers.

The target row does wrap onto its own line when needed, so the `+` button is
never pushed past the edge of the card.

`value_size` has no effect on `dial` or `tank`, whose text scales with the
drawing instead.

### Step size

By default, one press of `+`/`−` moves the setpoint by the `number` entity's own
`step`. That's often `1`, which means a lot of pressing to cover a useful range,
so you can override it:

```yaml
step: 5
```

This drives the console's buttons and the dial's slider. The entity's own `step`
still decides which values are valid, and `min`/`max` still limit them. So with
`step: 5` on an entity capped at 65, pressing up from 62 gives 65, not 67.

### Heat source

Above the controls, one line says what is actually heating the water:

- **Element heating**: the element is on.
- **Solar gaining**: the collector is more than 2° above the tank.
- **Idle**: neither.

That's the question a solar geyser raises: *is the sun paying for this, or am I?*
The `tank` layout goes further and animates the pipe only while solar is actually
contributing, with the gain (`+19.1°`) alongside.

## Colour

Water runs from cold blue to hot red, and the collector from dim olive to bright
sun. They're deliberately two different families: on a single shared scale, the
collector and tank would be the same colour whenever their temperatures were
close, which is most of the time, and you'd lose the ability to tell the two
rings apart at a glance.

Text coloured in the solar colour is blended towards your theme's own text
colour, so it's darker on a light theme and lighter on a dark one, and stays
readable in both.

## Troubleshooting

**Card doesn't appear**
The resource isn't loading. Check the URL and that the type is *JavaScript
Module*. The browser console logs `GEYSER-CARD v1.1.2` when the card loads.

**Setpoint snaps back after I change it**
The change isn't reaching the entity. Check that `setpoint_entity` really is a
`number` (not a read-only sensor), and look for an error in **Settings → System →
Logs** when the card calls `number.set_value`.

**Boost button does nothing**
Check that `boost_entity` is set and the automation is enabled. A disabled
automation ignores `trigger` without any error.

**Button says "Stop boost" when nothing is boosting**
It follows `element_entity`, not the automation. If your element runs on a
thermostat separately from boost, the button offers to stop it whenever the
element is on. Point `element_entity` at something boost-specific if you want it
to mean only boosting.

**Collector ring is stuck at the top of the scale**
The collector is above the automatic maximum. The scale widens in steps of 10 to
fit it, but you can set it yourself with `max: 120`.

## Licence

[MIT](LICENSE)
