import { Toaster } from 'react-hot-toast';
import { WalletContextProvider } from './components/WalletContextProvider';
import Dashboard from './components/Dashboard';

function App() {
  return (
    <WalletContextProvider>
      <div className="App">
        <Dashboard />
        <Toaster position="bottom-right" />
      </div>
    </WalletContextProvider>
  );
}

export default App;