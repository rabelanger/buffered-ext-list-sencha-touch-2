/*
 * 
 * Author: Scott Borduin, Lioarlan, LLC
 * License: GPL (http://www.gnu.org/licenses/gpl.html) -or- MIT (http://www.opensource.org/licenses/mit-license.php)
 * 
 * Release: 0.15
 * 
 * Acknowledgement: Based partly on public contributions from members of the Sencha.com bulletin board.
 * 
 */

Ext.define('Ext.ux.BufferedList', {
	extend: 'Ext.dataview.List',
	xtype	: 'bufferedlist',
	config: {
		/**
		 * @cfg {Number} minimumItems
		 * minimum number of items to be rendered at all times.
		 * @accessor
		*/
		minimumItems: 50,

		/**
		 * @cfg {Number} batchSize
		 * number of items to render incrementally when scrolling past
		 * top or bottom of currently rendered items. The default is
		 * workable on all tested platforms, but tweaking it may improve
		 * performance in specific cases.
		 * @accessor
		 */
		 batchSize: 50,

		/**
		 * @cfg {Number} cleanupBoundary
		 * maximum number of items to be rendered before cleanup is
		 * triggered on scrollStop. Must be > batchSize.
		 * @accessor
		 */
		cleanupBoundary: 125,

		/**
		 * @cfg {Boolean} blockScrollSelect
		 * if this is set to true, item selection will be blocked while the list is
		 * still scrolling.
		 * @accessor
		 */
		blockScrollSelect: false,

		/**
		 * @cfg {Number} maxItemHeight
		 * maxItemHeight should be set to approximate the maximum height, in pixels, of an item
		 * in the list. It does not restrict the height of list items, it is merely a number used
		 * in internal calculations. But if this number is too small, the list may fail to scroll
		 * all the way to the top. If too big, the scroll indicators sizing will be inaccurate (too
		 * small).
		 * @accessor
		 */
		maxItemHeight: 85
	},

	constructor: function() {
		this.callParent(arguments);
	},

	// override to fix subtle bug
	updatePinHeaders: function() {
		if ( this.firstRefreshDone ) {
			this.callParent(arguments);
		}
	},

	// override to fix subtle bug
	updateStore: function() {
		if ( this.firstRefreshDone ) {
			this.callParent(arguments);
		}
	},

	// override
	initialize: function() {
		// call base class initializer
		this.callParent(arguments);
		this.initializeMe();
	},

	initializeMe: function() {
		if ( this.hasOwnProperty('hasBeenInitialized') ) {
			return;
		}

		this.hasBeenInitialized = true;

		// Member variables to hold indicies of first and last items rendered.
		this.topItemRendered = 0;
		this.bottomItemRendered = 0;

		// cleanup task to be invoked on scroll stop.
		this.cleanupTask = new Ext.util.DelayedTask(this.itemCleanup,this);
		
		// flag used to make sure we don't collide with the cleanup thread
		this.isUpdating = false;
	
		// variables used to store state for group header display
		this.headerText = '';
		this.groupHeaders = [];

		// cache the reference to our scroller object, which will be used often
		this.scroller = this.getScrollable().getScroller();

		// initialize listeners for scroll events
		this.scroller.on({
			scrollstart: this.onScrollStart,
			scroll: this.renderOnScroll,
			scrollend: this.onScrollStop,
			scope: this
		});

		// holder of last known scroll position, useful for determining scroll direction
		this.lastScrollPos = 0;

		// array which holds all rendered items
		this.viewItemArray = [];

		// these three variables will point to the dom elements in our scrollable
		// area. The top and bottom proxies are just blank "spacers" of varying size,
		// while the list container holds the actual rendered list items.
		this.topProxy = null;
		this.listContainer = null;
		this.bottomProxy = null;

		// object which will hold arguments for onGuaranteedRange when the store
		// loads another page. Initialize for first render.
		this.cbArgs = {
			firstNew: 0,
			nItems: this.getMinimumItems(),
			mode: 'r'
		};
		this._store.on({
			guaranteedrange: this.onGuaranteedRange,
			scope: this
		});
		this.waitingOnGuarantee = false;

		// map of record indexes to records, so that we can guarantee
		// a record will be available on selection regardless of data
		// paging/purging
		this.indexToRecordMap = {};

		// used to prevent multiple initial renderings - see doRefresh
		this.firstRefreshDone = false;

		// we need to re-register all of the DataView event listeners to make
		// them target one more div element down, to account for the wrapper
		// div we create around our list elements. See DataView.doInitialize()
		var containerElem = this.container.element;
		var listeners = {
			delegate	: '> div',
			scope			: this,
			touchstart: 'onItemTouchStart',
			touchend  : 'onItemTouchEnd',
			tap		  	: 'onItemTap',
			touchmove : 'onItemTouchMove',
			doubletap : 'onItemDoubleTap',
			swipe	  	: 'onItemSwipe'
		};
		listeners[this.getTriggerEvent()] = this.onItemTrigger;
		containerElem.un(listeners);
		listeners.delegate = '> div > div';
		containerElem.on(listeners);
		this.refresh();
	},

	// Rendering related functions -----------------------------------------------------------------------------------


	// @override of dataView function - refresh simply re-renders current item list
	doRefresh: function() {
		var store = this._store;

		if ( this.firstRefreshDone === undefined )
			return;

		if ( !this.firstRefreshDone ) {
			// initialize our three divs
			var element = this.innerElement;

			this.topProxy = Ext.Element.create({ cls: 'ux-top-proxy' });
			this.listContainer = Ext.Element.create({ cls: 'ux-list-container' });
			this.bottomProxy = Ext.Element.create({ cls: 'ux-bottom-proxy' });

			this.topProxy.appendTo(element);
			this.listContainer.appendTo(element);
			this.bottomProxy.appendTo(element);

			// stripe record indexes for better performance later
			this.stripeRecordIndexes();

			// if this is a grouped list, or one with an index bar, initialize
			// relevant variables
			if (this.getGrouped() || this.getIndexBar())
			{
				this.createGroupingMap();
				if (this.getGrouped())
				{
					this.groupHeaders = [];
					this.createHeader();
				}
			}

			// show & buffer first items in the list
			this.topProxy.setHeight(0);
			this.bottomProxy.setHeight(0);
			if ( store && store.getCount() > 0 ) {
				this.refreshItemListAt(0); // renders first this.getMinimumItems() nodes in store
			}
			this.firstRefreshDone = true;
		}
		else {
			if (this.getGrouped()) {
				this.createGroupingMap();
			}
			this.updateItemList();
		}
	},

	// @private - render items into sliding window on scroll
	renderOnScroll: function() { // startRecord optional
		// cancel any cleanups pending from a scrollstop
		this.cleanupTask.cancel();
		
		// if we're still executing a cleanup task, or add/remove/replace, wait
		// for the next call
		if ( this.isUpdating ) {
			return 0;
		}

		var startIdx,
			ds = this._store,
			scrollPos = this.scroller.position.y,
			newTop = null,
			newBottom = null, 
			previousTop = this.topItemRendered, 
			previousBottom = this.bottomItemRendered,
			scrollDown = scrollPos >= this.lastScrollPos,
			incrementalRender = false,
			maxIndex = this.getRecordCount() - 1,
			thisHeight = this.getHeight(),
			listHeight = this.listContainer.getHeight(),
			topProxyHeight = this.topProxy.getHeight();

		this.lastScrollPos = scrollPos;

		// position of top of list relative to top of visible area (+above, -below)
		var listTopMargin = scrollPos - topProxyHeight;

		// position of bottom of list relative to bottom of visible area (+above, -below)
		var listBottomMargin = (scrollPos + thisHeight) - (topProxyHeight + listHeight);

		// scrolled into "white space"
		if ( listTopMargin <= -thisHeight || listBottomMargin >= thisHeight ) {
			incrementalRender = false;
			scrollDown = true;
			newTop = Math.max( (Math.floor(scrollPos/this.getMaxItemHeight())-1), 0 );
			newBottom = Math.min((newTop + this.getMinimumItems()) - 1,maxIndex);
		}
		// about to scroll off bottom of list
		else if ( scrollDown && listBottomMargin > -50 ) {
			newTop = previousTop;
			newBottom = Math.min(previousBottom + this.getBatchSize(),maxIndex);
			scrollDown = true;
			incrementalRender = true;
		}
		// about to scroll off top of list
		else if ( !scrollDown && listTopMargin < 50 && this.topItemRendered > 0 ) {
			newTop = Math.max(this.topItemRendered - this.getBatchSize(),0);
			newBottom = previousBottom;
			scrollDown = false;
			incrementalRender = true;
		}

		// check if we should prefetch a page
		var nItemsRendered, itemMargin;
		if ( ds.buffered ) {
			nItemsRendered = this.viewItemArray.length;
			if ( nItemsRendered !== 0 ) {
				itemMargin = (listHeight / nItemsRendered) * 20;
				if ( scrollDown && listBottomMargin > -itemMargin && this.bottomItemRendered < this.getRecordCount() - 1 ) {
					ds.prefetchPage( ds.getPageFromRecordIndex(this.bottomItemRendered) + 1 );
				}
				else if ( !scrollDown && listTopMargin < itemMargin && this.topItemRendered >=	ds.pageSize ) {
					ds.prefetchPage( ds.getPageFromRecordIndex(this.topItemRendered) - 1 );
				}
			}
		}

		// no need to render anything?
		if ( (newTop === null || newBottom === null) || 
			 (incrementalRender && newTop >= previousTop && newBottom <= previousBottom) ) {
			// still need to update list header appropriately
			if ( this.getGrouped() && this.getPinHeaders() ) {
				this.updateListHeader(scrollPos);
			}
			return 0;
		}
		
		// Jumped past boundaries of currently rendered items? Replace entire item list.
		if (this.bottomItemRendered === 0 || !incrementalRender) {
			// new item list starting with newTop
			this.replaceItemList(newTop,this.getMinimumItems());
		}
		// incremental - scrolling down
		else if (scrollDown) {
			startIdx = previousBottom + 1;
			this.appendItems(startIdx,this.getBatchSize());
		}
		// incremental - scrolling up
		else {
			startIdx = Math.max(previousTop - 1,0);
			this.insertItems(startIdx,this.getBatchSize());
			// collapse top proxy to zero if we're actually at the top.
			// This causes a minor behavioral glitch when the top proxy has
			// non-zero height - the list stops momentum at the top instead of
			// bouncing. But this only occurs when navigating into the middle
			// of the list, then scrolling all the way back to the top, and
			// doesn't prevent any other functionality from working. It could
			// probably be worked around with enough creativity ...
			if ( newTop === 0 ) {
				this.topProxy.setHeight(0);
				this.scrollToFirstItem();
			}
		}

		// zero out bottom proxy if we're at the bottom ...
		if ( newBottom === maxIndex ) {
			var bottomPadding = this.getHeight() - this.listContainer.getHeight();
			this.bottomProxy.setHeight(bottomPadding > 0 ? bottomPadding : 0);
		}

		// update list header appropriately
		if ( this.getGrouped() && this.getPinHeaders() ) {
			this.updateListHeader(this.scroller.position.y);
		}
	},

	onScrollStart: function() {
		this.lastScrollPos = this.scroller.position.y;
	},

	// @private - queue up tasks to perform on scroll end
	onScrollStop: function() {
		// prevents the list from selecting an item if the user just taps to stop the scroll
		if ( this.getBlockScrollSelect() ) {
			var saveLocked = this.getLocked();
			this.setLocked(true);
			Ext.defer(this.setLocked,100,this,[saveLocked]);
		}
		// Queue cleanup task.
		// The reason this is a delayed task, rather a direct execution, is that
		// scrollend fires when the user merely flicks the list for further scrolling.
		this.cleanupTask.delay(250);
	},

	// @private - render this.minimumItems() starting with the supplied index, and scroll the first
	// item to the top of the visible area.
	refreshItemListAt: function(startIndex) {
		// make sure we don't respond to scroll until this is done.
		this.isUpdating = true;
		this.replaceItemList(startIndex,this.getMinimumItems());
		this.scrollToFirstItem();
		// update list header appropriately
		if ( this.getGrouped() && this.getPinHeaders() ) {
			this.updateListHeader(this.scroller.position.y);
		}
		this.isUpdating = false;
	},

	// @private - scroll the first item to the top of the visible area (by scrolling to the
	// bottom of the top proxy).
	scrollToFirstItem: function() {
		// refresh makes sure the scroller has correct values of container sizing, etc.
		this.scroller.refresh();
		// suspend all events, since we want no side effects other than the scrolling position
		// change.
		this.scroller.suspendEvents();
		this.scroller.scrollTo(0, this.topProxy.getHeight());
		this.scroller.resumeEvents();
	},

	// @private
	updateListHeader: function(scrollPos) {
		scrollPos |= this.scroller.position.y;
		
		// make sure our header is created
		if (!this.header || !this.header.renderElement.dom) {
			this.createHeader();
			this.header.show();
		}

		// List being "pulled down" at top of list. Hide header.
		if ( scrollPos <= 0 ) {
			this.updateHeaderText(false);
			return;
		}

		// work backwards through groupHeaders until we find the
		// first one at or above the top of the viewable items.
		var i,
			headerNode,
			headerHeight = this.header.renderElement.getHeight(),
			nHeaders = this.groupHeaders.length, 
			headerMoveTop = scrollPos + headerHeight,
			groupTop,
			transform,
			headerText;
		for ( i = nHeaders - 1; i >= 0; i-- ) {
			headerNode = this.groupHeaders[i];
			groupTop = headerNode.offsetTop;
			if ( groupTop < headerMoveTop ) {
				// group header "pushing up" or "pulling down" on list header
				if (groupTop > scrollPos) {
					this.transformedHeader = true;
					transform = (scrollPos + headerHeight) - groupTop;
					this.translateHeader(transform);
					// make sure list header text displaying previous group
					this.updateHeaderText(this.getPreviousGroup(headerNode.firstChild.innerHTML).toUpperCase());
				}
				else {
					this.updateHeaderText(headerNode.firstChild.innerHTML);
					if ( this.transformedHeader ) {
						this.translateHeader(null);
						this.transformedHeader = false;
					}
				}
				break;
			}
		}
		// if we never got a group header above the top of the list, make sure
		// list header represents previous group text
		if ( i < 0 && headerNode ) {
			this.updateHeaderText(this.getPreviousGroup(headerNode.firstChild.innerHTML).toUpperCase());
			if ( this.transformedHeader ) {
				this.translateHeader(null);
				this.transformedHeader = false;
			}
		}
	},
	
	// @private
	updateHeaderText: function(groupString) {
		if ( !groupString ) {
			// "hide" header
			this.translateHeader(1000);
			this.transformedHeader = true;
			this.headerText = groupString;
		}
		else if ( groupString !== this.headerText ){
			this.header.setHtml(groupString);
			this.headerText = groupString;
		}
	},
	
	// @private
	itemCleanup: function() {
		// item cleanup just replaces the current item list with a new, shortened
		// item list. This is much faster than actually removing existing item nodes
		// one by one.
		if ( this.getViewItems().length > this.getCleanupBoundary() ) {
			this.updateItemList();
		}
	},


	// used by insertItems, appendItems, replaceItems. Builds HTML to add
	// to list container. Inserts group headers as appropriate, and appends
	// the corresponding record indicies to groupHeads if that arg is supplied.
	// @private
	buildItemHtml: function(firstItem,lastItem,groupHeads) {
		// loop over records, building up html string
		var i, 
			configArray = [],
			store = this._store,
			grpHeads = this.getGrouped(),
			record,
			groupId,
			itemConfig,
			data,
			node,
			selected = this.getSelection();

		for ( i = firstItem; i <= lastItem; i++ ) {
			record = this.getRecordAt(i);
			if ( store.buffered ) {
				this.indexToRecordMap[i] = record;
			}
			var data = record.getData();
			if (record) {
				// TODO: Move this into nestedStore...
				//Ext.apply(data, this.self.prepareAssociatedData(record));
				Ext.apply(data, this.prepareData(record));
			}
			itemConfig = this.container.getItemElementConfig(i,data);
			//itemConfig = this.getElementConfig(i,data);
			itemConfig.itemIndex = i;
			// If this item selected, add the selected class.
			// TODO - should this logic be moved to an overidden getItemElementConfig or wrapper thereof?
			if ( selected.indexOf(record) > -1 ) {
				itemConfig.cls += ' ' + this.getSelectedCls();
			}
			if ( grpHeads ) {
				groupId = store.getGroupString(record);
				if ( i === this.groupStartIndex(groupId) ) {
					// this item will be start of group
					itemConfig.children.unshift({cls: this.container.headerClsShortCache, html: groupId.toUpperCase()});
					if ( groupHeads ) {
						groupHeads.push(i);
					}
					// add footer class to previous item
					// TODO - keep checking to see if this is necessary. As of ST2-PR3, footer class not styled
					// and not used in any other way.
					/*
					if ( configArray.length > 0 ) {
						// previous item is in this batch
						configArray[configArray.length - 1].cls += (' ' + this.footerClsShortCache);
					}
					else if ( i - this.bottomItemRendered === 1 ) {
						// previous item already rendered - get it and add the footer class
						node = this.nodeFromRecordIndex(this.bottomItemRendered);
						if ( node )
							Ext.fly(node).addCls(this.footerClsShortCache);
					}
					else if ( i === firstItem && firstItem > 0 ) {
						// handle the case where the next insert batch must add footer class
						// to last item.
					} */
				}
			}
			configArray.push(itemConfig);
		}
		return Ext.DomHelper.markup(configArray);
	},

	// @private - insert, append, or replace items (DOM nodes) in list. firstNew is the starting index -
	// highest index for insert, lowest index for append/replace. nItems is the number of
	// items to render if possible, mode is a string i,a,r for insert, append, replace. Note -
	// replace wipes out all existing items and replaces them with the new range. This is the
	// only pipeline for adding/removing/replacing list nodes. Regardless of mode, if a rendered
	// list item is in the set of selected records, the selection UI (class) will be applied.
	renderListItems: function(firstNew,nItems,mode) {
		var insert = mode === 'i',
			append = mode === 'a',
			replace = mode === 'r',
			topProxyHeight = 0,
			sc = this.getRecordCount(),
			oldListHeight = this.listContainer.getHeight(),
			groupHeads = [],
			firstNode,
			lastNew,
			htm,
			i,
			node,
			nHeads,
			groupNodes;

		if ( append || replace ) {
			if ( firstNew >= sc ) {
				return 0;
			}
			else if ( firstNew + nItems > sc ) {
				nItems = sc - firstNew;
			}
			lastNew = (firstNew + nItems) - 1;
		}
		else if ( insert ) {
			if ( firstNew < 0 ) {
				 return 0;
			}
			lastNew = firstNew;
			firstNew = Math.max ( (lastNew - nItems) + 1, 0 ) ;
		}

		// capture info on proxy heights before rendering
		if ( replace ) {
			if ( firstNew === 0 ) {
				topProxyHeight = 0;
			}
			else if ( firstNode = this.nodeFromRecordIndex(firstNew) ) {
				topProxyHeight = firstNode.offsetTop;
			}
			else {
				topProxyHeight = firstNew * this.getMaxItemHeight();
			}
			// purge our record to index map - will be recreated in buildItemHtml
			// this allows the records to be garbage collected ...
			this.indexToRecordMap = {};
		}

		// build html string
		htm = this.buildItemHtml(firstNew,lastNew,groupHeads);

		// replace, append, or insert new html relative to existing list
		if ( append ) {
			Ext.DomHelper.insertHtml('beforeEnd',this.listContainer.dom,htm);
		}
		else if ( insert ) {
			Ext.DomHelper.insertHtml('afterBegin',this.listContainer.dom,htm);
		}
		else if ( replace ) {
//			this.groupHeaders.splice(0);
			this.listContainer.setHtml(htm);
		}

		// Set top and bottom proxy heights appropriately, and capture indicies of first and last
		// records currently rendered.
		if ( append ) {
			this.bottomProxy.setHeight(this.bottomProxy.getHeight() - (this.listContainer.getHeight() - oldListHeight));
			this.bottomItemRendered = lastNew;
		}
		else if ( insert ) {
			this.topProxy.setHeight(this.topProxy.getHeight() - (this.listContainer.getHeight() - oldListHeight));
			this.topItemRendered = firstNew;
		}
		else if ( replace ) {
			this.topProxy.setHeight(topProxyHeight);
			this.bottomProxy.setHeight((sc - lastNew - 1) * this.getMaxItemHeight());
			// save indicies of first and last items rendered
			this.topItemRendered = firstNew;
			this.bottomItemRendered = lastNew;
		}

		// maintain current view item array, rather than creating it on every call
		// to getViewItems.
		this.viewItemArray = Array.prototype.slice.call(this.listContainer.dom.childNodes);

		// add new group headers to header list
		if ( this.getGrouped() ) {
			nHeads = groupHeads.length;
			groupNodes = [];
			for ( i = 0; i < nHeads; i++ ) {
				node = this.nodeFromRecordIndex(groupHeads[i]);
				if ( node ) {
					groupNodes.push(node);
				}
			}
			if ( insert ) {
				this.groupHeaders = groupNodes.concat(this.groupHeaders);
			}
			else {
				this.groupHeaders = this.groupHeaders.concat(groupNodes);
			}
		}

		return nItems;
	},

	// @private - called when a range of records has been fetched from the proxy and guaranteed
	onGuaranteedRange: function(range,start,end) {
		var ds = this._store,
			cbarg = this.cbArgs;

		// load the range of records
		ds.suspendEvents();
		ds.loadRecords(range);
		ds.resumeEvents();


		// render the list items, using arguments supplied in our callback object
		this.renderListItems(cbarg.firstNew,cbarg.nItems,cbarg.mode);
		this.waitingOnGuarantee = false;
	},


	// @private - get the record at the specified server index, compensating for buffering
	getRecordAt: function(index) {
		var ds = this._store,
			rec = null;
		if ( !ds.buffered ) {
			rec = ds.getAt(index); // record has to be loaded in data
		}
		else if ( index >= ds.guaranteedStart && index <= ds.guaranteedEnd ) {
			rec = ds.getAt(index - ds.guaranteedStart); // record is loaded in data
		}
		else {
			// we're probably here due to an item selection, in which case our
			// map should be good.
			rec = this.indexToRecordMap[index]; //
		}
		return rec;
	},

	// @private - get the record count, compensating for buffering
	getRecordCount: function() {
		var ds = this._store;
		return ds.buffered ? ds.getTotalCount() : ds.getCount();
	},

	// @private - check if the store has the necessary record range loaded
	checkRecordsLoaded: function(firstRecord,lastRecord) {
		var ds = this._store;
		if ( !ds.buffered ) {
			return true;
		}
		else if ( Ext.isDefined(ds.guaranteedStart) && Ext.isDefined(ds.guaranteedEnd) ) {
			firstRecord = Math.max(0,firstRecord);
			lastRecord = Math.min(lastRecord,this.getRecordCount()-1);
			return firstRecord >= ds.guaranteedStart && lastRecord <= ds.guaranteedEnd;
		}
		return false;
	},

	// @private - Replace current contents of list container with new item list
	replaceItemList: function(firstNew,nItems) {
		var start = Math.max(0,firstNew),
		end = Math.min(firstNew+nItems-1,this.getRecordCount()-1);
		if ( this.checkRecordsLoaded(start,end) ) {
			this.renderListItems(firstNew,nItems,'r');
		}
		else if ( !this.waitingOnGuarantee ) {
//			  this.waitingOnGuarantee = true;
			this.cbArgs.firstNew = firstNew;
			this.cbArgs.nItems = nItems;
			this.cbArgs.mode = 'r';
			this._store.guaranteeRange(start,end);
		}
	},

	// Append a chunk of items to list container.
	// @private
	appendItems: function(firstNew,nItems) {
		var start = Math.max(0,firstNew),
		end = Math.min(firstNew+nItems-1,this.getRecordCount()-1);
		if ( this.checkRecordsLoaded(start,end) ) {
			return this.renderListItems(firstNew,nItems,'a');
		}
		else if ( !this.waitingOnGuarantee ) {
//			  this.waitingOnGuarantee = true;
			this.cbArgs.firstNew = firstNew;
			this.cbArgs.nItems = nItems;
			this.cbArgs.mode = 'a';
			this._store.guaranteeRange(start,end);
		}
	},

	// Insert a chunk of items at top of list container.
	insertItems: function(firstNew,nItems) {
		var start = Math.max(0,(firstNew-nItems)+1),
		end = Math.min(firstNew,this.getRecordCount()-1);
		if ( this.checkRecordsLoaded(start,end) ) {
			return this.renderListItems(firstNew,nItems,'i');
		}
		else if ( !this.waitingOnGuarantee ) {
//			  this.waitingOnGuarantee = true;
			this.cbArgs.firstNew = firstNew;
			this.cbArgs.nItems = nItems;
			this.cbArgs.mode = 'i';
			this._store.guaranteeRange(start,end);
		}
	},
	
	// @private - called on Add, Remove, Update, and cleanup.
	updateItemList: function() {
		// Update simply re-renders this.getMinimumItems() item nodes, starting with the first visible
		// item, and then restores any item selections. The current scroll position
		// of the first visible item will be maintained.
		this.isUpdating = true;
		var visItems = this.getVisibleItems(true);
		var startItem = visItems.length ? visItems[0] : 0;
		// create a buffer of 3 items at top
		startItem = Math.max(0,startItem-3);
		// replace items
		this.replaceItemList(startItem,this.getMinimumItems());
		this.isUpdating = false;
	},

	onBeforeHide: function() {
		// Stop the scroller when this component is hidden, e.g. when switching
		// tabs in a tab panel.
		var sc = this.scroller;
		sc.suspendEvents();
		sc.scrollTo(0,sc.position.y);
		sc.resumeEvents();
		return true;
	},



	// Grouping functions --------------------------------------------------------------------------------------------

	// @private overrides - we implement grouping in a quite different way
	updateGrouped: function() {

	},

	doRefreshHeaders: function() {

	},

	updatePinHeaders: function() {

	},

	// @private - get an encoded version of the string for use as a key in the hash
	getKeyFromId: function (groupId){
		return escape(groupId.toLowerCase());
	},

	// @private - get the group object corresponding to the given id
	getGroupObj:function(groupId){
		return this.groupIndexMap[this.getKeyFromId(groupId)];
	},

	// @private - get starting index of a group by group string (-1 if not found)
	groupStartIndex: function(groupId) {
		var gpo = this.getGroupObj(groupId);
		return gpo ? gpo.index : -1;
	},

	// @private - get group preceding the one in groupId
	getPreviousGroup: function(groupId) {
		return this.getGroupObj(groupId).prev;
	},

	// @private - get closest non-empty group to specified groupId from indexBar
	getClosestGroupId: function(groupId) {
		return this.getGroupObj(groupId).closest;
	},

	// @private - create a map of grouping strings to start index of the groups
	createGroupingMap: function() {
		this.groupIndexMap = {};
		var i,
			key,
			firstKey,
			record,
			store = this._store,
			tempMap = {},
			groupMap = this.groupIndexMap,
			prevGroup = '',
			sc = store.getCount();

		// build temporary map of group string to store index from store records
		for ( i = 0; i < sc; i++ ) {

			key = escape(store.getGroupString(store.getAt(i)).toLowerCase());
			if ( tempMap[key] === undefined ) {
				tempMap[key] = { index: i, closest: key, prev: prevGroup } ;
				prevGroup = key;
			}
			if ( !firstKey ) {
				firstKey = key;
			}
		}

		// now make sure our saved map has entries for every index string
		// in our index bar, if we have a bar.
		if (!!this.getIndexBar()) {
			Ext.applyIf(this.groupIndexMap,tempMap);
			var letters = this.getIndexBar().getLetters(),
				bc = letters.length,
				grpid,
				idx = 0,
				recobj;
				prevGroup = '',
				key = '';
			for ( i = 0; i < bc; i++ ) {
				grpid = letters[i].toLowerCase();
				recobj = tempMap[grpid];
				if ( recobj ) {
					idx = recobj.index;
					key = recobj.closest;
					prevGroup = recobj.prev;
				}
				else if ( !key ) {
					key = firstKey;
				}
				groupMap[grpid] = { index: idx, closest: key, prev: prevGroup };
			}
		}
		else {
			this.groupIndexMap = tempMap;
		}
	},

	// @private - respond to indexBar touch.
	onIndex: function(indexbar, html, target, opts) {
		// get first item of group from map
		var grpId 		= html.toLowerCase();
		var firstItem = this.groupStartIndex(grpId);

		// render new list of items into list container
		if ( firstItem >= 0  ) {

			// refresh items starting with firstItem, and scroll to that item
			this.refreshItemListAt(firstItem);

			// Set list header text to reflect new group.
			if ( this.getGrouped() && this.getPinHeaders() ) {
				this.updateHeaderText(this.getClosestGroupId(grpId).toUpperCase());
			}

		}
	},


	// Utility functions --------------------------------------------------------------------------------------------

	// @private override - return the dom nodes in the list
	getViewItems: function() {
		// weird place to initialize this, but that's what the base dataView:getViewItems does
		// TODO - probably due to the out-of-order initialization bug I reported.
		if (!this.elementContainer) {
			this.elementContainer = this.add(new Ext.Component());
		}
		return this.viewItemArray;
	},

	// @private check if index of store record corresponds to a currently rendered item
	isItemRendered: function(index) {
		// Trivial check after first render
		return this.getViewItems().length > 0 ?
			index >= this.topItemRendered && index <= this.bottomItemRendered : false;
	},

	// @private get record index associated with list item. node is DOM or Ext Element
	recordIndexFromNode: function(node) {
		if ( node instanceof Ext.Element)
			node = node.dom;
		return Number(node.getAttribute('itemIndex'));
	},

	// @private get record associated with list item. node is DOM or Ext Element
	recordFromNode: function(node) {
		return this.getRecordAt(this.recordIndexFromNode(node));
	},

	// @private get (server) index associated with record
	indexOfRecord: function(rec) {
		return this._store.indexOfTotal(rec);
	},

	// @private get DOM node representing list item associated with record. record is index or
	// actual record object
	nodeFromRecord: function(record) {
		if (!Ext.isNumber(record))
			record = this.indexOfRecord(record);
		return this.nodeFromRecordIndex(record);
	},

	// @private
	nodeFromRecordIndex: function(index) {
		return this.isItemRendered(index) ? this.getViewItems()[index - this.topItemRendered] : null;
	},

	// @private - stripe records with total count index property - speeds up getting the index
	// of a record. This is already done in buffered stores.
	stripeRecordIndexes: function() {
		var ds = this._store,
		rc,
		i;
		if ( !ds.buffered ) {
			rc = ds.getCount();
			for ( i = 0; i < rc; i++ ) {
				ds.getAt(i).index = i;
			}
		}
	},

	// @private return array of list item nodes actually visible. If returnAsIndexes is true,
	// this will be an array of record indexes, otherwise it will be an
	// array of nodes.
	getVisibleItems: function(returnAsIndexes) {
		var startPos = this.scroller.position.y;
		var elems = this.getViewItems(),
			nElems = elems.length,
			returnArray = [],
			thisHeight = this.getHeight(),
			firstItem = this.topItemRendered,
			node,
			offTop,
			i;
		for ( i = 0; i < nElems; i++ ){
			node = elems[i];
			offTop = node.offsetTop + node.offsetHeight;
			if ( offTop > startPos ) {
				returnArray.push(returnAsIndexes ? this.recordIndexFromNode(node) : node);
				if ( offTop - startPos > thisHeight ) {
					break;
				}
			}
		}
		return returnArray;
	},

// Overrides of DataView functions -----------------------------------------------------------------------------------

	// We have to override a bunch of selection-related DataView functions, just because they all assume
	// a 1 to 1 mapping between records in the store to dom nodes in the list. Most of the modifications
	// are just one or two lines, with the rest of the code copied. I've marked the changes to make future
	// updating easier (after PR3). It is worth noting that, as implemented, these methods rely a lot on
	// inefficient linear "indexOf" searches through arrays of records and dom nodes, and may need to be
	// re-implemented for performance reasons.

	// apply to the selection model to maintain visual UI cues
	onItemTrigger: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target); // SMB patch
		this.selectWithEvent(this.getRecordAt(index));
	},


	doAddPressedCls: function(record) {
		var me = this,
		index = me.indexOfRecord(record),
		item = me.nodeFromRecordIndex(index); // SMB patch
		if ( item )
			Ext.get(item).addCls(me.getPressedCls());
	},

	onItemTouchStart: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			store = me._store,
			record = this.getRecordAt(index),
			pressedDelay = me.getPressedDelay(),
			item = Ext.get(target);

		if (record) {
			if (pressedDelay > 0) {
				me.pressedTimeout = Ext.defer(me.doAddPressedCls, pressedDelay, me, [record]);
			}
			else {
				me.doAddPressedCls(record);
			}
		}

		item.on({
			touchmove: 'onItemTouchMove',
			scope	: me,
			single: true
		});

		me.fireEvent('itemtouchstart', me, index, target, e);
	},

	onItemTouchEnd: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			store = me._store,
			record = this.getRecordAt(index),
			item = Ext.get(target);

		if (this.hasOwnProperty('pressedTimeout')) {
			clearTimeout(this.pressedTimeout);
			delete this.pressedTimeout;
		}

		if (record) {
			Ext.get(target).removeCls(me.getPressedCls());
		}

		item.un({
			touchmove: 'onItemTouchMove',
			scope	: me
		});

		me.fireEvent('itemtouchend', me, index, target, e);
	},

	onItemTouchMove: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			store = me._store,
			record = this.getRecordAt(index),
			item = Ext.get(target);

		if (me.hasOwnProperty('pressedTimeout')) {
			clearTimeout(me.pressedTimeout);
			delete me.pressedTimeout;
		}

		if (record) {
			item.removeCls(me.getPressedCls());
		}
	},

	onItemTap: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			item = Ext.get(target);

		me.fireEvent('itemtap', me, index, item, e);
	},

	onItemDoubleTap: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			item = Ext.get(target);

		me.fireEvent('itemdoubletap', me, index, item, e);
	},

	onItemSwipe: function(e) {
		var me = this,
			target = e.getTarget(),
			index = me.recordIndexFromNode(target), // SMB patch
			item = Ext.get(target);

		me.fireEvent('itemswipe', me, index, item, e);
	},

	// invoked by the selection model to maintain visual UI cues
	doItemSelect: function(me, record) {
		var item = Ext.get(this.nodeFromRecord(record)); // SMB patch
		item.removeCls(me.getPressedCls());
		item.addCls(me.getSelectedCls());
	},


	doItemDeselect: function(me, record) {
		var item = Ext.get(this.nodeFromRecord(record));
		if (item) {
			item.removeCls([me.getPressedCls(), me.getSelectedCls()]); // SMB patch
		}
	},

	// each of the data store modifications is handled by the updateItemList
	// function, which will ensure that the currently visible items reflect
	// the latest state of the store.
	// @private - override
	onStoreUpdate : function(store, record) {
		if (this.getGrouped()) {
			this.createGroupingMap();
		}
		this.updateItemList();
	},

	// @private - override
	onStoreAdd : function(ds, records, index) {
		if (this.getGrouped()) {
			this.createGroupingMap();
		}
		this.updateItemList();
	},

	// @private - override
	onStoreRemove : function(ds, record, index) {
		if (this.getGrouped()) {
			this.createGroupingMap();
		}
		this.updateItemList();
	}

});