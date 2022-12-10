// Where filters are handled for URL matching.

// Allow any URL comment out botom line, and uncomment out the below line to let anything through
// export default /./

// Filter out for fallback urls or subdomains of https://ada.is or https://glitch.me
export default /(^\[fallback\] )|(^https?:\/\/(.+\.)?(ada.is|glitch.me|anildash.com))/i;