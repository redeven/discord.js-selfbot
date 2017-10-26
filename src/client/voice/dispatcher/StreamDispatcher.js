const { VoiceStatus } = require('../../../util/Constants');
const VolumeInterface = require('../util/VolumeInterface');
const { Writable } = require('stream');

const secretbox = require('../util/Secretbox');

const FRAME_LENGTH = 20;
const CHANNELS = 2;
const TIMESTAMP_INC = (48000 / 100) * CHANNELS;

const nonce = Buffer.alloc(24);
nonce.fill(0);

/**
 * @external Stream.writable
 * @see {@link https://nodejs.org/api/stream.html#stream_class_stream_writable}
 */

/**
 * The class that sends voice packet data to the voice connection.
 * ```js
 * // Obtained using:
 * voiceChannel.join().then(connection => {
 *   // You can play a file or a stream here:
 *   const dispatcher = connection.playFile('./file.mp3');
 * });
 * ```
 * @implements {VolumeInterface}
 * @extends {stream.Writable}
 */
class StreamDispatcher extends Writable {
  constructor(player, streamOptions) {
    super(streamOptions);
    /**
     * The Audio Player that controls this dispatcher
     * @type {AudioPlayer}
     */
    this.player = player;
    this.streamOptions = streamOptions;

    this.pausedSince = null;
    this._writeCallback = null;

    this.pausedTime = 0;
    this.count = 0;

    this.on('error', this.destroy.bind(this));
    this.on('finish', () => {
      this.destroy.bind(this);
      // Still emitting end for backwards compatibility, probably remove it in the future!
      this.emit('end');
    });
  }

  get _sdata() {
    return this.player.streamingData;
  }

  _write(chunk, enc, done) {
    if (!this.startTime) this.startTime = Date.now();
    this._playChunk(chunk);
    this._step(done);
  }

  _destroy(err, cb) {
    if (this.player.dispatcher !== this) return;
    this.player.dispatcher = null;
    const streams = this.player.streams;
    if (streams.opus) streams.opus.unpipe(this);
    if (streams.ffmpeg) streams.ffmpeg.destroy();
    super._destroy(err, cb);
  }

  /**
   * Pauses playback
   */
  pause() {
    this.pausedSince = Date.now();
  }

  /**
   * Resumes playback
   */
  unpause() {
    this.pausedTime += Date.now() - this.pausedSince;
    this.pausedSince = null;
    if (this._writeCallback) this._writeCallback();
  }

  /**
   * Set the bitrate of the current Opus encoder.
   * @param {number} value New bitrate, in kbps
   * If set to 'auto', the voice channel's bitrate will be used
   * @returns {boolean} true if the bitrate has been successfully changed.
   */
  setBitrate(value) { return this.player.setBitrate(value); }

  _step(done) {
    if (this.pausedSince) {
      this._writeCallback = done;
      return;
    }
    const next = FRAME_LENGTH + (this.count * FRAME_LENGTH) - (Date.now() - this.startTime - this.pausedTime);
    setTimeout(done.bind(this), next);
    if (this._sdata.sequence === (2 ** 16) - 1) this._sdata.sequence = -1;
    if (this._sdata.timestamp === (2 ** 32) - 1) this._sdata.timestamp = -TIMESTAMP_INC;
    this._sdata.sequence++;
    this._sdata.timestamp += TIMESTAMP_INC;
    this.count++;
  }

  _playChunk(chunk) {
    if (this.player.dispatcher !== this) return;
    this._setSpeaking(true);
    this._sendPacket(this._createPacket(this._sdata.sequence, this._sdata.timestamp, chunk));
  }

  _createPacket(sequence, timestamp, buffer) {
    const packetBuffer = Buffer.alloc(buffer.length + 28);
    packetBuffer.fill(0);
    packetBuffer[0] = 0x80;
    packetBuffer[1] = 0x78;

    packetBuffer.writeUIntBE(sequence, 2, 2);
    packetBuffer.writeUIntBE(timestamp, 4, 4);
    packetBuffer.writeUIntBE(this.player.voiceConnection.authentication.ssrc, 8, 4);

    packetBuffer.copy(nonce, 0, 0, 12);
    buffer = secretbox.methods.close(buffer, nonce, this.player.voiceConnection.authentication.secretKey);
    for (let i = 0; i < buffer.length; i++) packetBuffer[i + 12] = buffer[i];

    return packetBuffer;
  }

  _sendPacket(packet) {
    let repeats = 1;
    /**
     * Emitted whenever the dispatcher has debug information.
     * @event StreamDispatcher#debug
     * @param {string} info The debug info
     */
    this._setSpeaking(true);
    while (repeats--) {
      this.player.voiceConnection.sockets.udp.send(packet)
        .catch(e => {
          this._setSpeaking(false);
          this.emit('debug', `Failed to send a packet ${e}`);
        });
    }
  }

  _setSpeaking(value) {
    if (this.speaking === value) return;
    if (this.player.voiceConnection.status !== VoiceStatus.CONNECTED) return;
    this.speaking = value;
    /**
     * Emitted when the dispatcher starts/stops speaking.
     * @event StreamDispatcher#speaking
     * @param {boolean} value Whether or not the dispatcher is speaking
     */
    this.emit('speaking', value);
  }

  get volumeEditable() { return Boolean(this.player.streams.volume); }

  /**
   * Whether or not the Opus bitrate of this stream is editable
   */
  get bitrateEditable() { return this.streams.opus && this.streams.opus.setBitrate; }

  get volume() {
    return this.player.streams.volume ? this.player.streams.volume.volume : 1;
  }

  setVolume(value) {
    if (!this.player.streams.volume) return false;
    this.player.streams.volume.setVolume(value);
    return true;
  }
}

VolumeInterface.applyToClass(StreamDispatcher);

module.exports = StreamDispatcher;