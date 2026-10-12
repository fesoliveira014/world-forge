import { createRoot } from 'react-dom/client';
import WorldStudio from './app/WorldStudio';
import './app/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('The application root element is missing.');
}

createRoot(root).render(<WorldStudio />);
