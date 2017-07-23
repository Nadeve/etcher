/**
 * Created by anyvision on 16/07/17.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const settings = require('../../../models/settings');
const selectionState = require('../../../../shared/models/selection-state');
const analytics = require('../../../modules/analytics');
const exceptionReporter = require('../../../modules/exception-reporter');

const FTP = require("ftp");
const fs = require('fs');
const crypto = require('crypto');

module.exports = function(DriveSelectorService, WarningModalService, $timeout) {

  const self = this;

  console.debug("download-controller init");
  console.log("download-controller init");

  // ftp.connect({
  //   host: "ftp.dlptest.com",
  //   user: "dlpuser@dlptest.com",
  //   password: "KZhfl2N53lsZM7E8"
  // });
  // analytics.logDebug("Asdasdasdsasadasddasdasd\n\n\naesasdasd");
  // ftp.on('ready', () => {
  //   console.debug(`ftp ready`);
  //   ftp.list("/", false, (err, result) => {
  //     console.debug(`ftp List -`, {err, result});
  //     ftp.end();
  //   });
  // });
  // ftp.on('data', console.debug);

  function toReadable(bytes) {
    bytes = bytes ? parseFloat(bytes) : 0.0;
    let suffix = ["", "K", "M", "G", "T"];
    let idx = 0;

    while (bytes > 999) {
      bytes /= 1024;
      idx++;
    }

    return String(bytes.toFixed(2)) + suffix[idx] + "B";

  }

  function init() {

    if (self.ftp) self.ftp.destroy();

    self.loginFinished = false;
    self.ftp = new FTP();

    self.ftpStatus = "";

    self.progress = {
      _accum: 0,
      _size: 0,
      _packets: [],

      get percent() {
        if (this._size === 0) return 0.00;
        return ((this._accum / this._size) * 100).toFixed(2);
      },

      get accum() {
        return toReadable(this._accum);
      },

      get size() {
        return toReadable(this._size.toFixed(2));
      },

      get speed() {
        if (!this._packets || this._packets.length < 2) return 0;

        let latestPackets = this._packets.slice(-360);
        let size = latestPackets.map(packet => packet.size).reduce((a, b) => a + b);
        let dt = (latestPackets.slice(-1)[0].time - latestPackets[0].time) / 1000;
        return toReadable(size / dt) + "/s";
      },

      get eta() {
        if (!this._packets || this._packets.length < 2) return 0;
        if (this.percent === 100) return 0;

        let latestPackets = this._packets.slice(-360);
        let size = latestPackets.map(packet => packet.size).reduce((a, b) => a + b);
        let dt = (latestPackets.slice(-1)[0].time - latestPackets[0].time);

        let remainingSize = this._size - this._accum;
        let speed = size / dt;

        return remainingSize / speed;

      },

      set chunk(chunk) {
        let size = chunk.length;
        this._accum += size;
        this._packets.push({
          size: size,
          time: Date.now()
        });
      },

      set size(size) {
        this._size = size;
      },

    };

  }

  function onDlError(err) {
    self.ftpStatus = "dlerror";
    console.warn(err);
  }

  function onVerifyError() {
    self.ftpStatus = "verror";
  }

  function onCredError() {
    self.formErrors = true;
  }

  self.init = init;
  self.init();


  this.download = function() {
    console.log("init ftp..");
    console.time("self.ftp");

    const hash = crypto.createHash('md5');

    const remoteFilePath = "/Users/matanb/ftp/Fedora-Workstation-Live-x86_64-26-1.5.iso";
    const remoteHashPath = "/Users/matanb/ftp/Fedora-Workstation-Live-x86_64-26-1.5.iso.md5";

    const filePath = `${__dirname}/${remoteFilePath.split('/').slice(-1)[0]}`; // "./AnyOS.iso";
    const fileOptions = { defaultEncoding: 'binary' };
    const file = fs.createWriteStream(filePath, fileOptions);

    const hashLen = 32;
    let remoteHash = Buffer.allocUnsafe(0);

    file.on('finish', () => console.debug(`writing to file - finish`));

    file.on('error', onDlError);

    self.ftp.connect({
      host: "192.168.1.44",
      user: self.username,
      password: self.password
    });

    console.debug("connecting...");
    self.ftpStatus = "connecting";

    self.ftp.on("error", err => {
      console.warn("FTP Error:", err.message);
      if (err.message.indexOf('User') !== -1 || err.message.indexOf('Login') !== -1) return onCredError();
      onDlError();
    });

    self.ftp.on('ready', () => {
      console.debug(`self.ftp ready`);
      self.loginFinished = true;

      self.ftp.get(remoteHashPath, false, (err, stream) => {

        if (err) onDlError(err);

        stream.on('error', onDlError);
        stream.on('data', chunk => {
          remoteHash = Buffer.concat([remoteHash, chunk]);
        });
        stream.on('finish', () => {
          remoteHash = remoteHash.toString('ascii').substr(0, hashLen);
        });

        self.ftp.size(remoteFilePath, (err, size) => {

          if (err) onDlError(err);

          self.progress.size = size;
          self.ftp.get(remoteFilePath, false, (err, fileStream) => {

            if (err) onDlError(err);

            self.ftpStatus = "downloading";

            // fileStream.pipe(file);

            fileStream.on('data', chunk => {
              // Inc. accumulated dl size
              self.progress.chunk = chunk;
              hash.update(chunk);
              file.write(chunk);
              // console.debug(`self.ftp dl progress - ${toReadable(accum)} / ${toReadable(size)} (${((accum / size) * 100).toFixed(2)}%)`)
            });

            fileStream.on("finish", () => {

              console.debug("done!");
              self.ftpStatus = "done";

              self.hash = hash.digest('hex');
              file.end();
              self.hashesMatch = self.hash === remoteHash;

              if (!self.hashesMatch) {
                onVerifyError();
              } else {
                self.selectImageByPath(filePath);
              }

            });

            console.timeEnd("self.ftp");
            self.ftp.end();
          });
        });

      });
    });
  }
  // /**
  //  * @summary Open drive selector
  //  * @function
  //  * @public
  //  *
  //  * @example
  //  * DriveSelectionController.openDriveSelector();
  //  */
  // this.openDriveSelector = () => {
  //   DriveSelectorService.open().then((drive) => {
  //     if (!drive) {
  //       return;
  //     }
  //
  //     selectionState.setDrive(drive.device);
  //
  //     analytics.logEvent('Select drive', {
  //       device: drive.device,
  //       unsafeMode: settings.get('unsafeMode')
  //     });
  //   }).catch(exceptionReporter.report);
  // };
  //
  // /**
  //  * @summary Reselect a drive
  //  * @function
  //  * @public
  //  *
  //  * @example
  //  * DriveSelectionController.reselectDrive();
  //  */
  // this.reselectDrive = () => {
  //   this.openDriveSelector();
  //   analytics.logEvent('Reselect drive');
  // };



  const _ = require('lodash');
  const Bluebird = require('bluebird');
  const path = require('path');
  const messages = require('../../../../shared/messages');
  const errors = require('../../../../shared/errors');
  const imageStream = require('../../../../image-stream');
  const supportedFormats = require('../../../../shared/supported-formats');
  const analytics = require('../../../modules/analytics');
  const selectionState = require('../../../../shared/models/selection-state');
  const osDialog = require('../../../os/dialog');
  const exceptionReporter = require('../../../modules/exception-reporter');

    /**
     * @summary Main supported extensions
     * @constant
     * @type {String[]}
     * @public
     */
    self.mainSupportedExtensions = _.intersection([
      'img',
      'iso',
      'zip'
    ], supportedFormats.getAllExtensions());

    /**
     * @summary Extra supported extensions
     * @constant
     * @type {String[]}
     * @public
     */
    self.extraSupportedExtensions = _.difference(
      supportedFormats.getAllExtensions(),
      self.mainSupportedExtensions
    ).sort();

    /**
     * @summary Select image
     * @function
     * @public
     *
     * @param {Object} image - image
     *
     * @example
     * osDialogService.selectImage()
     *   .then(ImageSelectionController.selectImage);
     */
    self.selectImage = (image) => {
      if (!supportedFormats.isSupportedImage(image.path)) {
        const invalidImageError = errors.createUserError({
          title: 'Invalid image',
          description: messages.error.invalidImage({
            image
          })
        });

        osDialog.showError(invalidImageError);
        analytics.logEvent('Invalid image', image);
        return;
      }

      Bluebird.try(() => {
        let message = null;

        if (supportedFormats.looksLikeWindowsImage(image.path)) {
          analytics.logEvent('Possibly Windows image', image);
          message = messages.warning.looksLikeWindowsImage();
        } else if (!image.hasMBR) {
          analytics.logEvent('Missing partition table', image);
          message = messages.warning.missingPartitionTable();
        }

        if (message) {
          // TODO: `Continue` should be on a red background (dangerous action) instead of `Change`.
          // We want `X` to act as `Continue`, that's why `Continue` is the `rejectionLabel`
          return WarningModalService.display({
            confirmationLabel: 'Change',
            rejectionLabel: 'Continue',
            description: message
          });
        }

        return false;

      }).then((shouldChange) => {

        if (shouldChange) {
          return self.reselectImage();
        }

        selectionState.setImage(image);

        // An easy way so we can quickly identify if we're making use of
        // certain features without printing pages of text to DevTools.
        image.logo = Boolean(image.logo);
        image.bmap = Boolean(image.bmap);

        return analytics.logEvent('Select image', image);
      }).catch(exceptionReporter.report);
    };


  self.selectImageByPath = (imagePath) => {
    imageStream.getImageMetadata(imagePath)
      .then((imageMetadata) => {
        $timeout(() => {
          self.selectImage(imageMetadata);
        });
      })
      .catch((error) => {
        const imageError = errors.createUserError({
          title: 'Error opening image',
          description: messages.error.openImage({
            imageBasename: path.basename(imagePath),
            errorMessage: error.message
          })
        });

        osDialog.showError(imageError);
        analytics.logException(error);
      });
  };
};
