import {
  wurflSubmodule,
  storage
} from 'modules/wurflRtdProvider';
import * as ajaxModule from 'src/ajax';
import { loadExternalScriptStub } from 'test/mocks/adloaderStub.js';

describe('wurflRtdProvider', function () {
  describe('wurflSubmodule', function () {
    const altHost = 'http://example.local/wurfl.js';

    const wurfl_pbjs = {
      caps: ['wurfl_id', 'advertised_browser', 'advertised_browser_version', 'advertised_device_os', 'advertised_device_os_version', 'ajax_support_javascript', 'brand_name', 'complete_device_name', 'density_class', 'form_factor', 'is_android', 'is_app_webview', 'is_connected_tv', 'is_full_desktop', 'is_ios', 'is_mobile', 'is_ott', 'is_phone', 'is_robot', 'is_smartphone', 'is_smarttv', 'is_tablet', 'manufacturer_name', 'marketing_name', 'max_image_height', 'max_image_width', 'model_name', 'physical_screen_height', 'physical_screen_width', 'pixel_density', 'pointing_method', 'resolution_height', 'resolution_width'],
      over_quota: 0,
      global: {
        basic_set: {
          cap_indices: [0, 9, 15, 16, 17, 18, 32]
        },
        publisher: {
          cap_indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
        }
      },
      bidders: {
        bidder1: {
          cap_indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
        },
        bidder2: {
          cap_indices: [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22, 26, 29, 31, 32]
        }
      }
    }
    const WURFL = {
      advertised_browser: 'Chrome Mobile',
      advertised_browser_version: '130.0.0.0',
      advertised_device_os: 'Android',
      advertised_device_os_version: '6.0',
      ajax_support_javascript: !0,
      brand_name: 'Google',
      complete_device_name: 'Google Nexus 5',
      density_class: '3.0',
      form_factor: 'Feature Phone',
      is_android: !0,
      is_app_webview: !1,
      is_connected_tv: !1,
      is_full_desktop: !1,
      is_ios: !1,
      is_mobile: !0,
      is_ott: !1,
      is_phone: !0,
      is_robot: !1,
      is_smartphone: !1,
      is_smarttv: !1,
      is_tablet: !1,
      manufacturer_name: 'LG',
      marketing_name: '',
      max_image_height: 640,
      max_image_width: 360,
      model_name: 'Nexus 5',
      physical_screen_height: 110,
      physical_screen_width: 62,
      pixel_density: 443,
      pointing_method: 'touchscreen',
      resolution_height: 1920,
      resolution_width: 1080,
      wurfl_id: 'lg_nexus5_ver1',
    };

    // expected analytics values
    const expectedStatsURL = 'https://prebid.wurflcloud.com/v1/prebid/stats';
    const expectedData = JSON.stringify({ bidders: ['bidder1', 'bidder2'] });

    let sandbox;

    beforeEach(function () {
      sandbox = sinon.createSandbox();

      // Stub loadExternalScript to simulate WURFL.js loading and dispatch the event
      sandbox.stub(loadExternalScriptStub, 'callsFake').value((url, moduleType, moduleName, callback) => {
        // Call the callback to simulate script injection
        if (callback) callback();

        // Dispatch the WurflJSDetectionComplete event with data
        setTimeout(() => {
          const event = new CustomEvent('WurflJSDetectionComplete', {
            detail: { WURFL, wurfl_pbjs }
          });
          window.dispatchEvent(event);
        }, 0);
      });
    });

    afterEach(() => {
      // Restore the original functions
      sandbox.restore();
    });

    // Bid request config
    const reqBidsConfigObj = {
      adUnits: [{
        bids: [
          { bidder: 'bidder1' },
          { bidder: 'bidder2' },
          { bidder: 'bidder3' },
        ]
      }],
      ortb2Fragments: {
        global: {
          device: {},
        },
        bidder: {},
      }
    };

    // TTL handling tests
    describe('TTL handling', () => {
      it('should use valid (not expired) cached data without triggering async load', (done) => {
        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        // Setup cache with valid TTL (expires in future)
        const futureExpiry = Date.now() + 1000000; // expires in future
        const cachedData = {
          WURFL,
          wurfl_pbjs: { ...wurfl_pbjs, ttl: 2592000 },
          expire_at: futureExpiry
        };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        const callback = () => {
          // Verify global FPD enrichment happened (not over quota)
          expect(reqBidsConfigObj.ortb2Fragments.global.device).to.deep.include({
            make: 'Google',
            model: 'Nexus 5',
            devicetype: 4
          });

          // Verify no async load was triggered (cache is valid)
          expect(loadExternalScriptStub.called).to.be.false;

          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should use expired cached data and trigger async refresh', (done) => {
        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        // Setup cache with expired TTL
        const pastExpiry = Date.now() - 1000; // expired 1 second ago
        const cachedData = {
          WURFL,
          wurfl_pbjs: { ...wurfl_pbjs, ttl: 2592000 },
          expire_at: pastExpiry
        };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        const callback = () => {
          // Verify expired cache data is still used for enrichment
          expect(reqBidsConfigObj.ortb2Fragments.global.device).to.deep.include({
            make: 'Google',
            model: 'Nexus 5',
            devicetype: 4
          });

          // Verify bidders were enriched
          expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder1).to.exist;
          expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder2).to.exist;

          // Verify async load WAS triggered for refresh (cache expired)
          expect(loadExternalScriptStub.calledOnce).to.be.true;

          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });
    });

    // Debug mode initialization tests
    describe('Debug mode', () => {
      afterEach(() => {
        // Clean up window object after each test
        delete window.WurflRtdDebug;
      });

      it('should not create window.WurflRtdDebug when debug=false', () => {
        const config = { params: { debug: false } };
        wurflSubmodule.init(config);
        expect(window.WurflRtdDebug).to.be.undefined;
      });

      it('should not create window.WurflRtdDebug when debug is not configured', () => {
        const config = { params: {} };
        wurflSubmodule.init(config);
        expect(window.WurflRtdDebug).to.be.undefined;
      });

      it('should create window.WurflRtdDebug when debug=true', () => {
        const config = { params: { debug: true } };
        wurflSubmodule.init(config);
        expect(window.WurflRtdDebug).to.exist;
        expect(window.WurflRtdDebug.dataSource).to.equal('unknown');
        expect(window.WurflRtdDebug.cacheExpired).to.be.false;
      });
    });

    it('initialises the WURFL RTD provider', function () {
      expect(wurflSubmodule.init()).to.be.true;
    });

    describe('A/B testing', () => {
      it('should return true when A/B testing is disabled', () => {
        const config = { params: { abTest: false } };
        expect(wurflSubmodule.init(config)).to.be.true;
      });

      it('should return true when A/B testing is not configured', () => {
        const config = { params: {} };
        expect(wurflSubmodule.init(config)).to.be.true;
      });

      it('should return true for users in treatment group (random < abSplit)', () => {
        sandbox.stub(Math, 'random').returns(0.25); // 25% -> random value = 25
        const config = { params: { abTest: true, abName: 'test_sept', abSplit: 50 } };
        expect(wurflSubmodule.init(config)).to.be.true;
      });

      it('should return false for users in control group (random >= abSplit)', () => {
        sandbox.stub(Math, 'random').returns(0.75); // 75% -> random value = 75
        const config = { params: { abTest: true, abName: 'test_sept', abSplit: 50 } };
        expect(wurflSubmodule.init(config)).to.be.false;
      });

      it('should use default abSplit of 50 when not specified', () => {
        sandbox.stub(Math, 'random').returns(0.40); // 40% -> random value = 40
        const config = { params: { abTest: true, abName: 'test_sept' } };
        expect(wurflSubmodule.init(config)).to.be.true;
      });

      it('should handle abSplit of 0 (all control)', () => {
        sandbox.stub(Math, 'random').returns(0.01); // 1% -> random value = 1
        const config = { params: { abTest: true, abName: 'test_sept', abSplit: 0 } };
        expect(wurflSubmodule.init(config)).to.be.false;
      });

      it('should handle abSplit of 100 (all treatment)', () => {
        sandbox.stub(Math, 'random').returns(0.99); // 99% -> random value = 99
        const config = { params: { abTest: true, abName: 'test_sept', abSplit: 100 } };
        expect(wurflSubmodule.init(config)).to.be.true;
      });
    });

    it('should enrich multiple bidders with cached WURFL data (not over quota)', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup localStorage with cached WURFL data
      const cachedData = { WURFL, wurfl_pbjs };
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const callback = () => {
        // Verify global FPD has device data (not over quota)
        expect(reqBidsConfigObj.ortb2Fragments.global.device).to.deep.include({
          make: 'Google',
          model: 'Nexus 5',
          devicetype: 4,
          os: 'Android',
          osv: '6.0',
          hwv: 'Nexus 5',
          h: 1920,
          w: 1080,
          ppi: 443,
          pxratio: 3.0,
          js: 1
        });

        // bidder1 and bidder2 are authorized, should get ext.wurfl with all capabilities
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder1.device.ext.wurfl).to.deep.equal(WURFL);
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder2.device.ext.wurfl).to.deep.equal(WURFL);

        // bidder3 is NOT authorized, but should get basic+pub caps (tested in detail in dedicated test)
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3).to.exist;
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.ext.wurfl).to.exist;

        done();
      };

      const config = { params: {} };
      const userConsent = {};

      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);
    });

    it('should use LCE data when cache is empty and load WURFL.js async', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup empty cache
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(null);
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const expectedURL = new URL(altHost);
      expectedURL.searchParams.set('debug', 'true');
      expectedURL.searchParams.set('mode', 'prebid');
      expectedURL.searchParams.set('wurfl_id', 'true');
      expectedURL.searchParams.set('bidders', 'bidder1,bidder2,bidder3');

      const callback = () => {
        // Verify global FPD has LCE device data
        expect(reqBidsConfigObj.ortb2Fragments.global.device).to.exist;
        expect(reqBidsConfigObj.ortb2Fragments.global.device.js).to.equal(1);

        // No bidder enrichment should occur without cached WURFL data
        expect(reqBidsConfigObj.ortb2Fragments.bidder).to.deep.equal({});

        done();
      };

      const config = {
        params: {
          altHost: altHost,
          debug: true,
        }
      };
      const userConsent = {};

      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);

      // Verify WURFL.js is loaded async for future requests
      expect(loadExternalScriptStub.calledOnce).to.be.true;
      const loadExternalScriptCall = loadExternalScriptStub.getCall(0);
      expect(loadExternalScriptCall.args[0]).to.equal(expectedURL.toString());
      expect(loadExternalScriptCall.args[2]).to.equal('wurfl');
    });

    it('should enrich only bidders when over quota', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup localStorage with cached WURFL data (over quota)
      const wurfl_pbjs_over_quota = {
        ...wurfl_pbjs,
        over_quota: 1
      };
      const cachedData = { WURFL, wurfl_pbjs: wurfl_pbjs_over_quota };
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const callback = () => {
        // Verify global FPD does NOT have device data (over quota)
        expect(reqBidsConfigObj.ortb2Fragments.global.device).to.deep.equal({});

        // bidder1 and bidder2 are authorized, should get full device + ext.wurfl
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder1.device).to.deep.include({
          make: 'Google',
          model: 'Nexus 5',
          devicetype: 4,
          os: 'Android',
          osv: '6.0',
          hwv: 'Nexus 5',
          h: 1920,
          w: 1080,
          ppi: 443,
          pxratio: 3.0,
          js: 1
        });
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder1.device.ext.wurfl).to.deep.equal(WURFL);

        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder2.device).to.deep.include({
          make: 'Google',
          model: 'Nexus 5',
          devicetype: 4,
          os: 'Android',
          osv: '6.0',
          hwv: 'Nexus 5',
          h: 1920,
          w: 1080,
          ppi: 443,
          pxratio: 3.0,
          js: 1
        });
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder2.device.ext.wurfl).to.deep.equal(WURFL);

        // bidder3 is NOT authorized, should get nothing
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3).to.be.undefined;

        done();
      };

      const config = { params: {} };
      const userConsent = {};

      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);
    });

    it('should pass basic+pub caps to unauthorized bidders when under quota', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup localStorage with cached WURFL data (NOT over quota)
      const cachedData = { WURFL, wurfl_pbjs };
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const callback = () => {
        // Verify global FPD has device data (not over quota)
        expect(reqBidsConfigObj.ortb2Fragments.global.device).to.deep.include({
          make: 'Google',
          model: 'Nexus 5',
          devicetype: 4
        });

        // Calculate expected caps for basic + pub (no bidder-specific)
        const basicIndices = wurfl_pbjs.global.basic_set.cap_indices;
        const pubIndices = wurfl_pbjs.global.publisher.cap_indices;
        const allBasicPubIndices = [...new Set([...basicIndices, ...pubIndices])];

        const expectedBasicPubCaps = {};
        allBasicPubIndices.forEach(index => {
          const capName = wurfl_pbjs.caps[index];
          if (capName && capName in WURFL) {
            expectedBasicPubCaps[capName] = WURFL[capName];
          }
        });

        // bidder1 and bidder2 are authorized, should get ALL caps (basic + pub + bidder-specific)
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder1.device.ext.wurfl).to.deep.equal(WURFL);
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder2.device.ext.wurfl).to.deep.equal(WURFL);

        // bidder3 is NOT authorized, should get ONLY basic + pub caps (no bidder-specific)
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3).to.exist;
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device).to.exist;
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.ext).to.exist;
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.ext.wurfl).to.deep.equal(expectedBasicPubCaps);

        // Verify bidder3 does NOT have FPD device data (only authorized bidders get that when over quota)
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.make).to.be.undefined;
        expect(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.model).to.be.undefined;

        // Verify the caps calculation: basic+pub union should equal what bidder3 received
        const bidder3CapCount = Object.keys(reqBidsConfigObj.ortb2Fragments.bidder.bidder3.device.ext.wurfl).length;
        expect(bidder3CapCount).to.equal(allBasicPubIndices.length);

        done();
      };

      const config = { params: {} };
      const userConsent = {};

      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);
    });

    it('onAuctionEndEvent: should send analytics data using navigator.sendBeacon, if available', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup localStorage with cached WURFL data to populate enrichedBidders
      const cachedData = { WURFL, wurfl_pbjs };
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const sendBeaconStub = sandbox.stub(navigator, 'sendBeacon');

      const callback = () => {
        // Now call onAuctionEndEvent with enriched bidders
        const auctionDetails = {};
        const config = {};
        const userConsent = {};

        wurflSubmodule.onAuctionEndEvent(auctionDetails, config, userConsent);

        // Assertions
        expect(sendBeaconStub.calledOnce).to.be.true;
        expect(sendBeaconStub.calledWithExactly(expectedStatsURL, expectedData)).to.be.true;
        done();
      };

      const config = { params: {} };
      const userConsent = {};

      // First enrich bidders to populate enrichedBidders Set
      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);
    });

    it('onAuctionEndEvent: should send analytics data using fetch as fallback, if navigator.sendBeacon is not available', (done) => {
      // Reset reqBidsConfigObj to clean state
      reqBidsConfigObj.ortb2Fragments.global.device = {};
      reqBidsConfigObj.ortb2Fragments.bidder = {};

      // Setup localStorage with cached WURFL data to populate enrichedBidders
      const cachedData = { WURFL, wurfl_pbjs };
      sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
      sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
      sandbox.stub(storage, 'hasLocalStorage').returns(true);

      const sendBeaconStub = sandbox.stub(ajaxModule, 'sendBeacon').returns(false);
      const fetchAjaxStub = sandbox.stub(ajaxModule, 'fetch');

      const callback = () => {
        // Now call onAuctionEndEvent with enriched bidders
        const auctionDetails = {};
        const config = {};
        const userConsent = {};

        wurflSubmodule.onAuctionEndEvent(auctionDetails, config, userConsent);

        // Assertions
        expect(sendBeaconStub.calledOnce).to.be.true;

        expect(fetchAjaxStub.calledOnce).to.be.true;
        const fetchAjaxCall = fetchAjaxStub.getCall(0);
        expect(fetchAjaxCall.args[0]).to.equal(expectedStatsURL);
        expect(fetchAjaxCall.args[1].method).to.equal('POST');
        expect(fetchAjaxCall.args[1].body).to.equal(expectedData);
        expect(fetchAjaxCall.args[1].mode).to.equal('no-cors');
        done();
      };

      const config = { params: {} };
      const userConsent = {};

      // First enrich bidders to populate enrichedBidders Set
      wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, config, userConsent);
    });

    describe('device type mapping', () => {
      it('should map is_ott priority over form_factor', (done) => {
        const wurflWithOtt = { ...WURFL, is_ott: true, form_factor: 'Desktop' };
        const cachedData = { WURFL: wurflWithOtt, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(7);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map is_console priority over form_factor', (done) => {
        const wurflWithConsole = { ...WURFL, is_console: true, form_factor: 'Desktop' };
        const cachedData = { WURFL: wurflWithConsole, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(6);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map physical_form_factor out_of_home_device', (done) => {
        const wurflWithOOH = { ...WURFL, physical_form_factor: 'out_of_home_device', form_factor: 'Desktop' };
        const cachedData = { WURFL: wurflWithOOH, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(8);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Desktop to PERSONAL_COMPUTER', (done) => {
        const wurflDesktop = { ...WURFL, form_factor: 'Desktop' };
        const cachedData = { WURFL: wurflDesktop, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(2);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Smartphone to PHONE', (done) => {
        const wurflSmartphone = { ...WURFL, form_factor: 'Smartphone' };
        const cachedData = { WURFL: wurflSmartphone, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(4);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Tablet to TABLET', (done) => {
        const wurflTablet = { ...WURFL, form_factor: 'Tablet' };
        const cachedData = { WURFL: wurflTablet, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(5);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Smart-TV to CONNECTED_TV', (done) => {
        const wurflSmartTV = { ...WURFL, form_factor: 'Smart-TV' };
        const cachedData = { WURFL: wurflSmartTV, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(3);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Other Non-Mobile to CONNECTED_DEVICE', (done) => {
        const wurflOtherNonMobile = { ...WURFL, form_factor: 'Other Non-Mobile' };
        const cachedData = { WURFL: wurflOtherNonMobile, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(6);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should map form_factor Other Mobile to MOBILE_OR_TABLET', (done) => {
        const wurflOtherMobile = { ...WURFL, form_factor: 'Other Mobile' };
        const cachedData = { WURFL: wurflOtherMobile, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.equal(1);
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should return undefined when form_factor is missing', (done) => {
        const wurflNoFormFactor = { ...WURFL };
        delete wurflNoFormFactor.form_factor;
        const cachedData = { WURFL: wurflNoFormFactor, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.be.undefined;
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });

      it('should return undefined for unknown form_factor', (done) => {
        const wurflUnknownFormFactor = { ...WURFL, form_factor: 'UnknownDevice' };
        const cachedData = { WURFL: wurflUnknownFormFactor, wurfl_pbjs };
        sandbox.stub(storage, 'getDataFromLocalStorage').returns(JSON.stringify(cachedData));
        sandbox.stub(storage, 'localStorageIsEnabled').returns(true);
        sandbox.stub(storage, 'hasLocalStorage').returns(true);

        reqBidsConfigObj.ortb2Fragments.global.device = {};
        reqBidsConfigObj.ortb2Fragments.bidder = {};

        const callback = () => {
          expect(reqBidsConfigObj.ortb2Fragments.global.device.devicetype).to.be.undefined;
          done();
        };

        wurflSubmodule.getBidRequestData(reqBidsConfigObj, callback, { params: {} }, {});
      });
    });
  });
});
