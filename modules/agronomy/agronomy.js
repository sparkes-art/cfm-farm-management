// modules/agronomy/agronomy.js

export async function mountAgronomy(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>Agronomy</h1><p class="page-subtitle">Paddock management and farm mapping</p></div>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="empty-state">
          <div class="empty-icon">🗺</div>
          <p>Agronomy module — in development.</p>
          <p class="mt-2">Will include paddock registry, crop history, and GeoJSON-based farm mapping.</p>
        </div>
      </div>
    </div>
  `;
}
