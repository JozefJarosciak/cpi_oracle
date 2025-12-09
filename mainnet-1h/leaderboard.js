// Configuration
const ITEMS_PER_PAGE = 20;
const HISTORY_PER_PAGE = 20;

// State
let allUsers = [];
let currentPage = 0;
let selectedUser = null;
let selectedUserRank = 0;
let historyPage = 0;
let historyTotal = 0;