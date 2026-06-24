// modules/weather/weather.js

export async function mountWeather(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>Weather</h1><p class="page-subtitle">Station data and rainfall records</p></div>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="empty-state">
          <div class="empty-icon">🌦</div>
          <p>Weather module — in development.</p>
          <p class="mt-2">Will integrate BOM station data and allow manual rainfall recording by paddock.</p>
        </div>
      </div>
    </div>
  `;
}
