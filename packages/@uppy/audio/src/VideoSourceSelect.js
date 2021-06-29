const { h } = require('preact')

module.exports = ({ currentDeviceId, videoSources, onChangeVideoSource }) => {
  return (
    <div className="uppy-Audio-videoSource">
      <select
        className="uppy-u-reset uppy-Audio-videoSource-select"
        onChange={(event) => { onChangeVideoSource(event.target.value) }}
      >
        {videoSources.map((videoSource) => (
          <option
            key={videoSource.deviceId}
            value={videoSource.deviceId}
            selected={videoSource.deviceId === currentDeviceId}
          >
            {videoSource.label}
          </option>
        ))}
      </select>
    </div>
  )
}
