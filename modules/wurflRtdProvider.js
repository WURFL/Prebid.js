import { submodule } from '../src/hook.js';
import { fetch, sendBeacon } from '../src/ajax.js';
import { loadExternalScript } from '../src/adloader.js';
import {
  mergeDeep,
  prefixLog,
} from '../src/utils.js';
import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { getStorageManager } from '../src/storageManager.js';

// Constants
const REAL_TIME_MODULE = 'realTimeData';
const MODULE_NAME = 'wurfl';

// WURFL_JS_HOST is the host for the WURFL service endpoints
const WURFL_JS_HOST = 'https://prebid.wurflcloud.com';
// WURFL_JS_ENDPOINT_PATH is the path for the WURFL.js endpoint used to load WURFL data
const WURFL_JS_ENDPOINT_PATH = '/wurfl.js';
// STATS_ENDPOINT_PATH is the path for the stats endpoint used to send analytics data
const STATS_ENDPOINT_PATH = '/v1/prebid/stats';

// Storage keys for localStorage caching
const WURFL_WJS_STORAGE_KEY = 'wurfl-wjs';

// OpenRTB 2.0 device type constants
// Based on OpenRTB 2.6 specification
const ORTB2_DEVICE_TYPE = {
  MOBILE_OR_TABLET: 1,
  PERSONAL_COMPUTER: 2,
  CONNECTED_TV: 3,
  PHONE: 4,
  TABLET: 5,
  CONNECTED_DEVICE: 6,
  SET_TOP_BOX: 7,
  OOH_DEVICE: 8
};

// OpenRTB 2.0 device fields that can be enriched from WURFL data
const ORTB2_DEVICE_FIELDS = [
  'make', 'model', 'devicetype', 'os', 'osv', 'hwv',
  'h', 'w', 'ppi', 'pxratio', 'js'
];

const logger = prefixLog('[WURFL RTD Submodule]');

// Storage manager for WURFL RTD provider
export const storage = getStorageManager({
  moduleType: MODULE_TYPE_RTD,
  moduleName: MODULE_NAME,
});

// enrichedBidders holds a list of prebid bidder names, of bidders which have been
// injected with WURFL data
const enrichedBidders = new Set();

/**
 * Safely gets an object from localStorage with JSON parsing
 * @param {string} key The storage key
 * @returns {Object|null} Parsed object or null if not found/invalid
 */
function getObjectFromStorage(key) {
  if (!storage.hasLocalStorage() || !storage.localStorageIsEnabled()) {
    return null;
  }

  try {
    const dataStr = storage.getDataFromLocalStorage(key);
    return dataStr ? JSON.parse(dataStr) : null;
  } catch (e) {
    logger.logError(`Error parsing stored data for key ${key}:`, e);
    return null;
  }
}

/**
 * Safely sets an object to localStorage with JSON stringification
 * @param {string} key The storage key
 * @param {Object} data The data to store
 * @returns {boolean} Success status
 */
function setObjectToStorage(key, data) {
  if (!storage.hasLocalStorage() || !storage.localStorageIsEnabled()) {
    return false;
  }

  try {
    storage.setDataInLocalStorage(key, JSON.stringify(data));
    return true;
  } catch (e) {
    logger.logError(`Error storing data for key ${key}:`, e);
    return false;
  }
}

/**
 * enrichDeviceFPD enriches the global device object with device data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Object} deviceData Device data to enrich with
 */
function enrichDeviceFPD(reqBidsConfigObj, deviceData) {
  if (!deviceData || !reqBidsConfigObj?.ortb2Fragments?.global) {
    return;
  }

  const prebidDevice = reqBidsConfigObj.ortb2Fragments.global.device || {};
  const enrichedDevice = {};

  ORTB2_DEVICE_FIELDS.forEach(field => {
    // Check if field already exists in prebid device
    if (prebidDevice[field] !== undefined) {
      return;
    }

    // Check if deviceData has a valid value for this field
    if (deviceData[field] === undefined) {
      return;
    }

    // Copy the field value from deviceData to enrichedDevice
    enrichedDevice[field] = deviceData[field];
  });

  // Use mergeDeep to properly merge into global device
  mergeDeep(reqBidsConfigObj.ortb2Fragments.global, { device: enrichedDevice });
}

/**
 * enrichDeviceBidder enriches bidder-specific device data with WURFL data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Set} bidders Set of bidder codes
 * @param {WurflJSDevice} wjsDevice WURFL.js device data with permissions and caps
 */
function enrichDeviceBidder(reqBidsConfigObj, bidders, wjsDevice) {
  bidders.forEach((bidderCode) => {
    // keep track of enriched bidders
    enrichedBidders.add(bidderCode);
    // inject WURFL data
    const bidderDevice = wjsDevice.Bidder(bidderCode);
    mergeDeep(reqBidsConfigObj.ortb2Fragments.bidder, { [bidderCode]: bidderDevice });
  });
}

/**
 * loadWurflJsAsync loads WURFL.js asynchronously and stores response to localStorage
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Set} bidders Set of bidder codes
 */
function loadWurflJsAsync(config, bidders) {
  const altHost = config.params?.altHost ?? null;
  const isDebug = config.params?.debug ?? false;

  let host = WURFL_JS_HOST;
  if (altHost) {
    host = altHost;
  }

  const url = new URL(host);
  url.pathname = WURFL_JS_ENDPOINT_PATH;

  if (isDebug) {
    url.searchParams.set('debug', 'true');
  }

  url.searchParams.set('mode', 'prebid');
  url.searchParams.set('wurfl_id', 'true');

  // Add bidders list for server optimization
  if (bidders && bidders.size > 0) {
    url.searchParams.set('bidders', Array.from(bidders).join(','));
  }

  try {
    loadExternalScript(url.toString(), MODULE_TYPE_RTD, MODULE_NAME, () => {
      logger.logMessage('async WURFL.js script injected');
      window.WURFLPromises.complete.then((res) => {
        logger.logMessage('async WURFL.js data received', res);
        if (res.wurfl_pbjs) {
          // Create optimized cache object with only relevant device data
          const cacheData = {
            WURFL: res.WURFL,
            wurfl_pbjs: res.wurfl_pbjs,
          };
          setObjectToStorage(WURFL_WJS_STORAGE_KEY, cacheData);
          logger.logMessage('WURFL.js device cache stored to localStorage');
        } else {
          logger.logError('invalid async WURFL.js for Prebid response');
        }
      }).catch((err) => {
        logger.logError('async WURFL.js promise error:', err);
      });
    });
  } catch (err) {
    logger.logError('async WURFL.js loading error:', err);
  }
}

/**
 * init initializes the WURFL RTD submodule
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
const init = (_, _) => {
  logger.logMessage('initialized');
  return true;
}

/**
 * getBidRequestData enriches the OpenRTB 2.0 device data with WURFL data
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Function} callback Called on completion
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
const getBidRequestData = (reqBidsConfigObj, callback, config, _) => {
  // Extract bidders from request configuration
  const bidders = new Set();
  reqBidsConfigObj.adUnits.forEach(adUnit => {
    adUnit.bids.forEach(bid => {
      bidders.add(bid.bidder);
    });
  });

  // Priority 1: Check if WURFL.js response is cached
  const cachedWurflData = getObjectFromStorage(WURFL_WJS_STORAGE_KEY);
  if (cachedWurflData) {
    logger.logMessage('using cached WURFL.js data');
    const wjsDevice = WurflJSDevice.fromCache(cachedWurflData);
    if (!wjsDevice._isOverQuota()) {
      enrichDeviceFPD(reqBidsConfigObj, wjsDevice.FPD());
    }
    enrichDeviceBidder(reqBidsConfigObj, bidders, wjsDevice);
    callback();
    return;
  }

  // Priority 2: return LCE data
  logger.logMessage('generating fresh LCE data');
  const fpdDevice = WurflLCEDevice.FPD();
  enrichDeviceFPD(reqBidsConfigObj, fpdDevice);

  // Load WURFL.js async for future requests
  loadWurflJsAsync(config, bidders);

  callback();
}

/**
 * onAuctionEndEvent is called when the auction ends
 * @param {Object} auctionDetails Auction details
 * @param {Object} config Configuration for WURFL RTD submodule
 * @param {Object} userConsent User consent data
 */
function onAuctionEndEvent(auctionDetails, config, userConsent) {
  // TODO: Implement onAuctionEndEvent logic
}

// The WURFL submodule
export const wurflSubmodule = {
  name: MODULE_NAME,
  init,
  getBidRequestData,
  onAuctionEndEvent,
}

// Register the WURFL submodule as submodule of realTimeData
submodule(REAL_TIME_MODULE, wurflSubmodule);


// ==================== WURFL JS DEVICE MODULE ====================
const WurflJSDevice = {
  // Private properties
  _wurflData: null,       // WURFL data containing capability values (from window.WURFL)
  _pbjsData: null,        // wurfl_pbjs data with caps array and permissions (from response)
  _basicCaps: null,       // Cached basic capabilities (computed once)
  _pubCaps: null,         // Cached publisher capabilities (computed once)
  _device: null,          // Cached device object (computed once)

  // Constructor from WURFL.js local cache
  fromCache(res) {
    this._wurflData = res.WURFL || {};
    this._pbjsData = res.wurfl_pbjs || {};
    this._basicCaps = null;
    this._pubCaps = null;
    this._device = null;
    return this;
  },

  // Private method - converts a given value to a number
  _toNumber(value) {
    if (value === '' || value === null) {
      return undefined;
    }
    const num = Number(value);
    return Number.isNaN(num) ? undefined : num;
  },

  // Private method - filters capabilities based on indices
  _filterCaps(indexes) {
    const data = {};
    const caps = this._pbjsData.caps;          // Array of capability names
    const wurflData = this._wurflData;         // WURFL data containing capability values

    if (!indexes || !caps || !wurflData) {
      return data;
    }

    indexes.forEach((index) => {
      const capName = caps[index];  // Get capability name by index
      if (capName && capName in wurflData) {
        data[capName] = wurflData[capName];  // Get value from WURFL data
      }
    });

    return data;
  },

  // Private method - gets basic capabilities
  _getBasicCaps() {
    if (this._basicCaps !== null) {
      return this._basicCaps;
    }
    const basicCaps = this._pbjsData.permissions?.["__basic__"]?.cap_indices || [];
    this._basicCaps = this._filterCaps(basicCaps);
    return this._basicCaps;
  },

  // Private method - gets publisher capabilities
  _getPubCaps() {
    if (this._pubCaps !== null) {
      return this._pubCaps;
    }
    const pubCaps = this._pbjsData.permissions?.["__pub__"]?.cap_indices || [];
    this._pubCaps = this._filterCaps(pubCaps);
    return this._pubCaps;
  },

  // Private method - gets bidder-specific capabilities
  _getBidderCaps(bidderCode) {
    const bidderCaps = this._pbjsData.permissions?.[bidderCode]?.cap_indices || [];
    return this._filterCaps(bidderCaps);
  },

  // Private method - checks if bidder has permissions
  _hasPermission(bidderCode) {
    return !!(this._pbjsData.permissions && bidderCode in this._pbjsData.permissions);
  },

  // Private method - checks if over quota
  _isOverQuota() {
    return this._pbjsData.over_quota === 1;
  },

  // Private method - returns the ortb2 device type based on WURFL data
  _makeOrtb2DeviceType(wurflData) {
    if (wurflData.is_mobile) {
      if (!('is_phone' in wurflData) || !('is_tablet' in wurflData)) {
        return undefined;
      }
      if (wurflData.is_phone || wurflData.is_tablet) {
        return ORTB2_DEVICE_TYPE.MOBILE_OR_TABLET;
      }
      return ORTB2_DEVICE_TYPE.CONNECTED_DEVICE;
    }
    if (wurflData.is_full_desktop) {
      return ORTB2_DEVICE_TYPE.PERSONAL_COMPUTER;
    }
    if (wurflData.is_connected_tv) {
      return ORTB2_DEVICE_TYPE.CONNECTED_TV;
    }
    if (wurflData.is_phone) {
      return ORTB2_DEVICE_TYPE.PHONE;
    }
    if (wurflData.is_tablet) {
      return ORTB2_DEVICE_TYPE.TABLET;
    }
    if (wurflData.is_ott) {
      return ORTB2_DEVICE_TYPE.SET_TOP_BOX;
    }
    return undefined;
  },

  // Public API - returns device object for First Party Data (global)
  FPD() {
    if (this._device !== null) {
      return this._device;
    }

    const wd = this._wurflData;
    if (!wd) {
      this._device = {};
      return this._device;
    }

    this._device = {
      make: wd.brand_name,
      model: wd.model_name,
      devicetype: this._makeOrtb2DeviceType(wd),
      os: wd.advertised_device_os,
      osv: wd.advertised_device_os_version,
      hwv: wd.model_name,
      h: wd.resolution_height,
      w: wd.resolution_width,
      ppi: wd.pixel_density,
      pxratio: this._toNumber(wd.density_class),
      js: this._toNumber(wd.ajax_support_javascript)
    };
    return this._device;
  },

  // Public API - returns device with bidder-specific ext data
  Bidder(bidderCode) {
    if (!this._hasPermission(bidderCode)) {
      return {};
    }

    // Start with empty device, populate only if publisher is over quota
    // When over quota, we send device data to each authorized bidder individually
    let fpdDevice = {};
    if (this._isOverQuota()) {
      fpdDevice = this.FPD();
    }

    if (!this._pbjsData.caps) {
      return { device: fpdDevice };
    }

    // Create union of all capability data (bidder-specific overrides basic and pub)
    const wurflData = {
      ...this._getBasicCaps(),
      ...this._getPubCaps(),
      ...this._getBidderCaps(bidderCode)
    };

    return {
      device: {
        ...fpdDevice,
        ext: {
          wurfl: wurflData
        }
      }
    };
  }
};
// ==================== END WURFL JS DEVICE MODULE ====================



// ==================== WURFL LCE DEVICE MODULE ====================
const WurflLCEDevice = {
  // Private mappings for device detection
  _desktopMapping: new Map([
    ["Windows NT", "Windows"],
    ["Macintosh; Intel Mac OS X", "macOS"],
    ["Mozilla/5.0 (X11; Linux", "Linux"],
    ["X11; Ubuntu; Linux x86_64", "Linux"],
    ["Mozilla/5.0 (X11; CrOS", "ChromeOS"],
  ]),

  _tabletMapping: new Map([
    ["iPad; CPU OS ", "iPadOS"],
  ]),

  _smartphoneMapping: new Map([
    ["Android", "Android"],
    ["iPhone; CPU iPhone OS", "iOS"],
  ]),

  _smarttvMapping: new Map([
    ["Web0S", "LG webOS"],
    ["SMART-TV; Linux; Tizen", "Tizen"],
  ]),

  _ottMapping: new Map([
    ["Roku", "Roku OS"],
    ["Xbox", "Windows"],
    ["PLAYSTATION", "PlayStation OS"],
    ["PlayStation", "PlayStation OS"],
  ]),

  _makeMapping: new Map([
    ["motorola", "Motorola"],
    [" moto ", "Motorola"],
    ["Android", "Generic"],
    ["iPad", "Apple"],
    ["iPhone", "Apple"],
    ["Firefox", "Mozilla"],
    ["Edge", "Microsoft"],
    ["Chrome", "Google"],
  ]),

  _modelMapping: new Map([
    ["Android", "Android"],
    ["iPad", "iPad"],
    ["iPhone", "iPhone"],
    ["Firefox", "Firefox"],
    ["Edge", "Edge"],
    ["Chrome", "Chrome"],
  ]),

  // Private helper methods
  _parseOsVersion(ua, osName) {
    let osv = "";
    switch (osName) {
      case "Windows": {
        const matches = ua.match(/Windows NT ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "macOS": {
        const matches = ua.match(/Mac OS X ([\d_]+)/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "iOS": {
        const matches = ua.match(/iPhone; CPU iPhone OS ([\d_]+) like Mac OS X/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "iPadOS": {
        const matches = ua.match(/iPad; CPU OS ([\d_]+) like Mac OS X/);
        if (matches) {
          osv = matches[1].replaceAll('_', '.');
          return osv;
        }
        return "";
      }
      case "Android": {
        // For Android UAs with a decimal
        const matches1 = ua.match(/Android ([\d.]+)/);
        // For Android UAs without a decimal
        const matches2 = ua.match(/Android ([\d]+)/);
        if (matches1) {
          return matches1[1];
        }
        if (matches2) {
          return matches2[1];
        }
        return "";
      }
      case "ChromeOS": {
        const matches = ua.match(/CrOS x86_64 ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "Tizen": {
        const matches = ua.match(/Tizen ([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "Roku OS": {
        const matches = ua.match(/Roku\/DVP [\dA-Z]+ [\d.]+\/([\d.]+)/);
        if (matches) {
          return matches[1];
        }
        return "";
      }
      case "PlayStation OS": {
        // PS4
        const matches1 = ua.match(/PlayStation \d\/([\d.]+)/);
        // PS3
        const matches2 = ua.match(/PLAYSTATION \d ([\d.]+)/);
        if (matches1) {
          return matches1[1];
        }
        if (matches2) {
          return matches2[1];
        }
        return "";
      }
      case "Linux":
      case "LG webOS":
      default:
        return "";
    }
  },

  _makeDeviceInfo(deviceType, osName, ua) {
    return { deviceType, osName, osVersion: this._parseOsVersion(ua, osName) };
  },

  _getDeviceInfo(ua) {
    // Iterate over ottMapping
    // Should remove above Desktop
    for (const [osToken, osName] of this._ottMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.SET_TOP_BOX, osName, ua);
      }
    }
    // Iterate over desktopMapping
    for (const [osToken, osName] of this._desktopMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.PERSONAL_COMPUTER, osName, ua);
      }
    }
    // Iterate over tabletMapping
    for (const [osToken, osName] of this._tabletMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.TABLET, osName, ua);
      }
    }
    // Android Tablets
    if (ua.includes("Android") && !ua.includes("Mobile Safari") && ua.includes("Safari")) {
      return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.TABLET, 'Android', ua);
    }
    // Iterate over smartphoneMapping
    for (const [osToken, osName] of this._smartphoneMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.PHONE, osName, ua);
      }
    }
    // Iterate over smarttvMapping
    for (const [osToken, osName] of this._smarttvMapping) {
      if (ua.includes(osToken)) {
        return this._makeDeviceInfo(ORTB2_DEVICE_TYPE.CONNECTED_TV, osName, ua);
      }
    }
    return { deviceType: "", osName: "", osVersion: "" };
  },

  _getDevicePixelRatioValue(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 1;
    }
    return (
      win.devicePixelRatio ||
      (win.screen.deviceXDPI / win.screen.logicalXDPI) ||
      Math.round(win.screen.availWidth / win.document.documentElement.clientWidth)
    );
  },

  _getScreenWidth(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 0;
    }
    return Math.round(win.screen.width * this._getDevicePixelRatioValue(win));
  },

  _getScreenHeight(win = (typeof window !== "undefined" ? window : undefined)) {
    if (!win) {
      return 0;
    }
    return Math.round(win.screen.height * this._getDevicePixelRatioValue(win));
  },

  _getMake(ua) {
    for (const [makeToken, brandName] of this._makeMapping) {
      if (ua.includes(makeToken)) {
        return brandName;
      }
    }
    return 'Generic';
  },

  _getModel(ua) {
    for (const [modelToken, modelName] of this._modelMapping) {
      if (ua.includes(modelToken)) {
        return modelName;
      }
    }
    return '';
  },

  // Public API - returns device object for First Party Data (global)
  FPD() {
    const useragent = typeof window !== "undefined" ? window.navigator.userAgent : "";
    const deviceInfo = this._getDeviceInfo(useragent);

    const win = typeof window !== "undefined" ? window : undefined;
    const pixelRatio = this._getDevicePixelRatioValue(win);
    const screenWidth = this._getScreenWidth(win);
    const screenHeight = this._getScreenHeight(win);

    const brand = this._getMake(useragent);
    const model = this._getModel(useragent);

    return {
      devicetype: deviceInfo.deviceType,
      make: brand,
      model: model,
      os: deviceInfo.osName,
      osv: deviceInfo.osVersion,
      hwv: model,
      h: screenHeight,
      w: screenWidth,
      pxratio: pixelRatio,
      js: 1
    };
  }
};
// ==================== END WURFL LCE DEVICE MODULE ====================
