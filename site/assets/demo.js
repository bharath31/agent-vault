// Drives the hero "agent run" terminal: reveals lines one at a time, then loops.
// No JS / reduced-motion → all lines stay visible (set in CSS), nothing animates.
;(() => {
  const term = document.querySelector('[data-demo]')
  if (!term) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) return

  const lines = Array.from(term.querySelectorAll('.tl'))
  if (!lines.length) return
  term.classList.add('anim') // CSS hides lines until .shown
  let i = 0
  let timer

  const tick = () => {
    if (i < lines.length) {
      const line = lines[i]
      line.classList.add('shown')
      const delay = Number(line.dataset.d) || 400
      i += 1
      timer = setTimeout(tick, delay)
    } else {
      timer = setTimeout(restart, 3200)
    }
  }
  const restart = () => {
    for (const l of lines) l.classList.remove('shown')
    i = 0
    tick()
  }

  // The hero terminal is above the fold — start shortly after load.
  timer = setTimeout(tick, 400)
})()
