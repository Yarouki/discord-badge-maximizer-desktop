setTimeout(() => {
  document.getElementById('boot')?.classList.add('done')
  document.body.removeAttribute('aria-busy')
  for (const node of document.querySelectorAll('.topbar, .sidenav, main')) node.inert = false
}, 6000)
