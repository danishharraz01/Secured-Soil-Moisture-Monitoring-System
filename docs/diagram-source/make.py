# Generates the updated block diagram and flowcharts as SVG, then they're rendered to PNG.
from html import escape

OR_FILL, OR_STROKE, INK = '#F9D49B', '#B8752A', '#2b2118'
SEC_FILL, SEC_STROKE = '#D7ECD2', '#4C8A3F'   # green = security control added in v3
FONT = "font-family='Helvetica, Arial, sans-serif'"

def text_lines(x, y, lines, size=13, weight='normal', color=INK):
    out, lh = [], size * 1.25
    y0 = y - (len(lines) - 1) * lh / 2
    for i, l in enumerate(lines):
        out.append(f"<text x='{x}' y='{y0 + i*lh}' {FONT} font-size='{size}' font-weight='{weight}' fill='{color}' text-anchor='middle' dominant-baseline='central'>{escape(l)}</text>")
    return ''.join(out)

ARROW_DEFS = """<defs><marker id='ah' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>
<path d='M0,0 L10,5 L0,10 z' fill='#555'/></marker></defs>"""

def line(x1, y1, x2, y2):
    return f"<line x1='{x1}' y1='{y1}' x2='{x2}' y2='{y2}' stroke='#555' stroke-width='1.6' marker-end='url(#ah)'/>"

def poly(pts):
    d = ' '.join(f'{x},{y}' for x, y in pts)
    return f"<polyline points='{d}' fill='none' stroke='#555' stroke-width='1.6' marker-end='url(#ah)'/>"

def label(x, y, t, anchor='middle'):
    return f"<text x='{x}' y='{y}' {FONT} font-size='12' font-weight='bold' fill='#333' text-anchor='{anchor}'>{t}</text>"

# ---------------- Block diagram ----------------
def block_diagram():
    W, BW, BH, GX, GY, X0, Y0 = 1120, 210, 92, 60, 70, 40, 90
    rows = [
        [("Sense the soil moisture", "(virtual sensor)", 0), ("Microcontroller receives", "data from sensor", 0),
         ("Relay module activates", "sprinkler (<60%, off at 80%)", 0), ("Send notification to user", "through application", 0)],
        [("Microcontroller encrypts", "data (AES-128-GCM)", 1), ("Signs + sends over", "HTTPS (TLS, pinned cert)", 1),
         ("Server verifies & decrypts", "(signature, replay, input)", 1), ("Sends events to", "syslog server (TLS)", 1)],
        [("Open the Android", "application", 0), ("User logs in", "(password)", 1),
         ("User receives OTP", "via email", 1), ("Key in the OTP", "on the application", 1)],
        [("Application displays", "data to the user", 0), ("Log out after", "10 minutes idle", 1),
         ("Data encrypted", "(RSA-3072 + AES-256)", 1), ("Application stores", "signed backup in cloud", 0)],
    ]
    # snake order: row0 L->R, row1 R->L, row2 L->R, row3 R->L
    H = Y0 + 4 * BH + 3 * GY + 120
    s = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}' height='{H}' viewBox='0 0 {W} {H}'>", ARROW_DEFS,
         f"<rect width='{W}' height='{H}' fill='white'/>",
         text_lines(W/2, 40, ["Block diagram: Secured Soil Moisture Monitoring System (v3)"], 20, 'bold')]
    pos = {}
    for r, row in enumerate(rows):
        for c, (t1, t2, sec) in enumerate(row):
            col = c if r % 2 == 0 else 3 - c
            x = X0 + col * (BW + GX) + 10
            y = Y0 + r * (BH + GY)
            pos[(r, c)] = (x, y)
            fill, stroke = (SEC_FILL, SEC_STROKE) if sec else (OR_FILL, OR_STROKE)
            s.append(f"<rect x='{x}' y='{y}' width='{BW}' height='{BH}' rx='6' fill='{fill}' stroke='{stroke}' stroke-width='1.5'/>")
            s.append(text_lines(x + BW/2, y + BH/2 - 9, [t1], 14, 'bold'))
            s.append(text_lines(x + BW/2, y + BH/2 + 12, [t2], 12.5))
    for r in range(4):
        for c in range(3):
            (x1, y1), (x2, y2) = pos[(r, c)], pos[(r, c+1)]
            if r % 2 == 0: s.append(line(x1 + BW + 6, y1 + BH/2, x2 - 6, y2 + BH/2))
            else: s.append(line(x1 - 6, y1 + BH/2, x2 + BW + 6, y2 + BH/2))
        if r < 3:
            x, y = pos[(r, 3)]
            s.append(line(x + BW/2, y + BH + 6, x + BW/2, y + BH + GY - 6))
    ly = H - 50
    s.append(f"<rect x='{X0+10}' y='{ly-12}' width='22' height='16' fill='{OR_FILL}' stroke='{OR_STROKE}'/>")
    s.append(f"<text x='{X0+40}' y='{ly+1}' {FONT} font-size='13' fill='#333'>Function from the original proposal</text>")
    s.append(f"<rect x='{X0+330}' y='{ly-12}' width='22' height='16' fill='{SEC_FILL}' stroke='{SEC_STROKE}'/>")
    s.append(f"<text x='{X0+360}' y='{ly+1}' {FONT} font-size='13' fill='#333'>Security control (implemented and tested)</text>")
    s.append('</svg>')
    return '\n'.join(s)

# ---------------- Flowchart helpers ----------------
class FC:
    def __init__(self):
        self.s = []
    def term(self, cx, cy, t, w=150, h=44):
        self.s.append(f"<rect x='{cx-w/2}' y='{cy-h/2}' width='{w}' height='{h}' rx='{h/2}' fill='white' stroke='#444' stroke-width='1.5'/>")
        self.s.append(text_lines(cx, cy, [t], 14, 'bold'))
        return (cx, cy, w, h)
    def proc(self, cx, cy, lines, w=200, h=60, sec=False):
        fill, stroke = (SEC_FILL, SEC_STROKE) if sec else ('white', '#444')
        self.s.append(f"<rect x='{cx-w/2}' y='{cy-h/2}' width='{w}' height='{h}' rx='3' fill='{fill}' stroke='{stroke}' stroke-width='1.5'/>")
        self.s.append(text_lines(cx, cy, lines, 13))
        return (cx, cy, w, h)
    def io(self, cx, cy, lines, w=200, h=56):
        k = 16
        pts = f"{cx-w/2+k},{cy-h/2} {cx+w/2+k},{cy-h/2} {cx+w/2-k},{cy+h/2} {cx-w/2-k},{cy+h/2}"
        self.s.append(f"<polygon points='{pts}' fill='white' stroke='#444' stroke-width='1.5'/>")
        self.s.append(text_lines(cx, cy, lines, 13))
        return (cx, cy, w, h)
    def dec(self, cx, cy, lines, w=190, h=90):
        pts = f"{cx},{cy-h/2} {cx+w/2},{cy} {cx},{cy+h/2} {cx-w/2},{cy}"
        self.s.append(f"<polygon points='{pts}' fill='#FFF7E6' stroke='#444' stroke-width='1.5'/>")
        self.s.append(text_lines(cx, cy, lines, 12.5))
        return (cx, cy, w, h)
    def conn(self, cx, cy, t):
        self.s.append(f"<circle cx='{cx}' cy='{cy}' r='20' fill='white' stroke='#444' stroke-width='1.5'/>")
        self.s.append(text_lines(cx, cy, [t], 14, 'bold'))
        return (cx, cy, 40, 40)
    def down(self, a, b, lab=None):
        self.s.append(line(a[0], a[1] + a[3]/2, b[0], b[1] - b[3]/2 - 3))
        if lab: self.s.append(label(a[0] + 8, a[1] + a[3]/2 + 16, lab, 'start'))

def flowchart():
    W, H = 1240, 1380
    f = FC()
    f.s += [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}' height='{H}' viewBox='0 0 {W} {H}'>", ARROW_DEFS,
            f"<rect width='{W}' height='{H}' fill='white'/>",
            text_lines(W/2, 36, ["Flowchart: Secured Soil Moisture Monitoring System (v3)"], 20, 'bold')]

    # ---- Column 1: sensing, watering, sending ----
    X = 175
    f.s.append(text_lines(X + 60, 78, ["1. Sensor node and server"], 15, 'bold', '#555'))
    a = f.term(X, 120, 'Start')
    b = f.proc(X, 200, ['Sensor checks the', "soil's moisture"])
    c = f.proc(X, 290, ['Microcontroller', 'receives data'])
    d = f.dec(X, 395, ['Moisture < 60%?'])
    e = f.proc(X, 510, ['Microcontroller encrypts', 'data (AES-128-GCM)'], sec=True)
    g = f.proc(X, 600, ['Sign (HMAC) + send', 'over HTTPS'], sec=True)
    h = f.dec(X, 710, ['Server: signature,', 'replay, values OK?'])
    i = f.proc(X, 830, ['Decrypt and store in', 'tamper-evident hash chain'], sec=True)
    j = f.proc(X, 920, ['Send event to', 'syslog server (TLS)'], sec=True)
    k = f.conn(X, 1010, 'A')
    for p, q in [(a, b), (b, c), (c, d)]: f.down(p, q)
    f.down(d, e, 'No'); f.down(e, g); f.down(g, h); f.down(h, i, 'Yes'); f.down(i, j); f.down(j, k)
    # Yes branch: relay + notify
    r1 = f.proc(X + 260, 395, ['Relay module', 'activates sprinkler'], w=180)
    r2 = f.proc(X + 260, 485, ['Notify user', 'through application'], w=180)
    f.s.append(line(X + 95, 395, X + 260 - 93, 395)); f.s.append(label(X + 104, 386, 'Yes', 'start'))
    f.down(r1, r2)
    f.s.append(poly([(X + 260, 515), (X + 260, 600), (X + 103, 600)]))
    # reject branch
    rj = f.proc(X + 260, 710, ['Reject request,', 'log WARNING to syslog'], w=180, sec=True)
    f.s.append(line(X + 95, 710, X + 260 - 93, 710)); f.s.append(label(X + 104, 701, 'No', 'start'))
    f.s.append(poly([(X + 260, 740), (X + 260, 1010), (X + 24, 1010)]))
    f.s.append(text_lines(X + 60, 1060, ['↻ repeats every reading'], 12, 'normal', '#666'))

    # ---- Column 2: app login, display, backup ----
    X2 = 700
    f.s.append(text_lines(X2 + 40, 78, ["2. Mobile application"], 15, 'bold', '#555'))
    a2 = f.conn(X2, 120, 'A')
    b2 = f.proc(X2, 200, ['Open the Android', 'application'])
    c2 = f.proc(X2, 290, ['User logs in', '(username + password)'])
    d2 = f.dec(X2, 395, ['Password', 'correct?'])
    e2 = f.proc(X2, 510, ['User receives OTP', 'via email (5 min, 1 use)'], sec=True)
    g2 = f.dec(X2, 620, ['Correct OTP?'])
    h2 = f.io(X2, 735, ['Display data to', 'the user'])
    i2 = f.dec(X2, 845, ['Idle for', '10 minutes?'])
    j2 = f.proc(X2, 960, ['Log out and', 'revoke session'], sec=True)
    for p, q in [(a2, b2), (b2, c2), (c2, d2)]: f.down(p, q)
    f.down(d2, e2, 'Yes'); f.down(e2, g2); f.down(g2, h2, 'Yes'); f.down(h2, i2); f.down(i2, j2, 'Yes')
    # No loops back to login (on the left side)
    for dy, lab in [(395, 'No'), (620, 'No (5 tries)')]:
        f.s.append(poly([(X2 - 95, dy), (X2 - 150, dy), (X2 - 150, 290), (X2 - 103, 290)]))
        f.s.append(label(X2 - 144, dy + 18, lab, 'start'))
    # idle No -> keep displaying
    f.s.append(poly([(X2 + 95, 845), (X2 + 135, 845), (X2 + 135, 735), (X2 + 108, 735)]))
    f.s.append(label(X2 + 100, 837, 'No', 'start'))

    # ---- backup sub-flow ----
    f.s.append(text_lines(X2, 1050, ["Every 10 minutes (and on admin request):"], 13, 'bold', '#555'))
    b1 = f.proc(X2, 1110, ['Data encrypted (RSA-3072', '+ AES-256-GCM), signed'], w=230, sec=True)
    b3 = f.proc(X2, 1200, ['Application stores', 'backup in cloud'], w=230)
    b4 = f.term(X2, 1285, 'End')
    f.down(b1, b3); f.down(b3, b4)

    # ---- Column 3: motion sensor ----
    X3 = 1065
    f.s.append(text_lines(X3, 78, ["3. Motion sensor"], 15, 'bold', '#555'))
    m = [f.term(X3, 120, 'Start'),
         f.proc(X3, 200, ['PIR sensor detects', 'movement around'], w=210),
         f.proc(X3, 290, ['Data sent to the', 'microcontroller'], w=210),
         f.proc(X3, 380, ['MCU turns the', 'red LED on'], w=210),
         f.proc(X3, 470, ['MCU sends encrypted,', 'signed event to server'], w=210, sec=True),
         f.proc(X3, 560, ['Server logs WARNING', 'to syslog server'], w=210, sec=True),
         f.proc(X3, 650, ['SMS sent to the user', '(max 1 per 2 min)'], w=210),
         f.proc(X3, 740, ['App shows notification', '+ red LED indicator'], w=210),
         f.term(X3, 830, 'End')]
    for p, q in zip(m, m[1:]): f.down(p, q)

    ly = H - 30
    f.s.append(f"<rect x='40' y='{ly-12}' width='22' height='16' fill='{SEC_FILL}' stroke='{SEC_STROKE}'/>")
    f.s.append(f"<text x='70' y='{ly+1}' {FONT} font-size='13' fill='#333'>Security control (implemented and tested)</text>")
    f.s.append('</svg>')
    return '\n'.join(f.s)

open('/home/claude/diagrams/block-diagram.svg', 'w').write(block_diagram())
open('/home/claude/diagrams/flowchart.svg', 'w').write(flowchart())
print('ok')
